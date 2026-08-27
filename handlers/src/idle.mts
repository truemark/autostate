/**
 * idle.mts
 * ----------------------------------------------------------------------------
 * Idle detection for EC2 instances, driven entirely by CloudWatch alarms.
 *
 * This is deliberately a different shape to scheduler.mts. scheduler.mts is
 * about *time* ("stop this at 18:00"), so it can compute a deterministic future
 * timestamp and hand it to a Step Functions Wait state. Idleness is about
 * *condition* ("nothing has happened for an hour"), which has no future
 * timestamp to wait on and must be sampled from a metric time series.
 *
 * Rather than poll GetMetricData on a schedule and do that sampling ourselves,
 * we let CloudWatch do it. For each opted-in instance we maintain:
 *
 *   - one CHILD metric alarm per configured signal, where the alarm is phrased
 *     as "this signal is LOW", so ALARM means "this signal looks idle"
 *   - one COMPOSITE alarm that ANDs all the children together, so it only
 *     enters ALARM when every configured signal has looked idle for the whole
 *     tagged window
 *
 * CloudWatch emits an EventBridge event on every alarm state change
 * (source "aws.cloudwatch", detail-type "CloudWatch Alarm State Change"), so
 * the composite going to ALARM is our trigger. No SNS or SQS hop is required.
 *
 * That gives this file exactly two responsibilities, and neither of them is
 * metric math:
 *
 *   1. RECONCILE - make the alarm set for an instance match its tags. Driven by
 *      tag-change events, instance state-change events, and a low frequency
 *      sweep that repairs drift.
 *   2. VERIFY - when a composite alarm fires, re-check the guards that an alarm
 *      cannot know about (hold tag, ASG membership, spot, grace period) and
 *      return a decision.
 *
 * IMPORTANT: this handler never mutates an instance. Like scheduler.mts, it
 * describes and decides; the state machine acts. The decision object returned by
 * the verify path is shaped to satisfy the existing ActionRouter choice in
 * cdk/lib/autostate-construct.ts, which routes on $.execute, $.resource.type and
 * $.action, and whose StopEc2Instance task reads $.resource.id. That means the
 * stop path already exists and no new Step Functions task is needed.
 *
 * TAG SURFACE
 *
 * Configuration is two tags, and one of them is optional:
 *
 *   autostate:idle-detection = enabled | notify-only | disabled
 *   autostate:idle-threshold = duration/grace/cpu-max/network-max/connections-max
 *
 * Every field of idle-threshold has a default, and a blank field takes it, so
 * the tag can be omitted entirely or filled in partially:
 *
 *   (tag absent)      -> 60/30/3/1MB/auto  (all defaults)
 *   60/30/3//auto     -> network-max defaults to 1MB
 *   90                -> duration 90, everything else default
 *   60/30/3/1MB/off   -> connection signal disabled
 *
 * A third tag, autostate:hold-until, is a temporary user-set escape hatch rather
 * than configuration - see parseHoldUntil.
 *
 * Requires @aws-sdk/client-cloudwatch to be added to handlers/package.json.
 * ----------------------------------------------------------------------------
 */

import {
  DescribeInstancesCommand,
  DescribeInstancesCommandOutput,
  EC2Client,
  Instance,
  Tag,
} from '@aws-sdk/client-ec2';
import {
  AlarmType,
  CloudWatchClient,
  ComparisonOperator,
  DeleteAlarmsCommand,
  DescribeAlarmsCommand,
  DescribeAlarmsCommandOutput,
  GetMetricStatisticsCommand,
  PutCompositeAlarmCommand,
  PutMetricAlarmCommand,
  StandardUnit,
  Statistic,
} from '@aws-sdk/client-cloudwatch';

// Clients are created at module scope so the SDK connection pool and any
// credential lookups are reused across warm Lambda invocations.
const ec2Client = new EC2Client({});
const cloudWatchClient = new CloudWatchClient({});

// ---------------------------------------------------------------------------
// Configuration constants
// ---------------------------------------------------------------------------

/**
 * Tag namespace. cdk/lib/scheduler-function.ts already sets TAG_PREFIX in the
 * Lambda environment, so we honour it here rather than hardcoding the prefix
 * the way scheduler.mts currently does.
 */
const TAG_PREFIX = process.env['TAG_PREFIX'] ?? 'autostate:';

/**
 * Alarm name prefixes.
 *
 * These two prefixes MUST NOT be prefixes of one another. The EventBridge rule
 * that triggers a stop will prefix-match on the composite prefix, and if child
 * alarm names also started with that prefix then a SINGLE signal going idle
 * would trigger a stop, completely bypassing the AND. That is the most
 * dangerous failure mode in this design, so the names are kept disjoint:
 *
 *   composite -> autostate-idle-i-0abc123
 *   child     -> autostate-signal-i-0abc123-cpu
 */
const COMPOSITE_ALARM_PREFIX = 'autostate-idle-';
const SIGNAL_ALARM_PREFIX = 'autostate-signal-';

/**
 * Every child alarm uses a 5-minute period, regardless of the metric.
 *
 * Native EC2 metrics are published every 5 minutes under basic monitoring, so
 * 300 aligns exactly. CloudWatch agent metrics are typically published every 60
 * seconds, and CloudWatch will roll those five data points up into our 300s
 * bucket. Because every child alarm uses the Maximum statistic, that rollup
 * takes the *highest* value in the bucket, which is the conservative reading we
 * want: a 90-second burst of real work cannot be averaged away into looking
 * idle. Using one period everywhere also keeps EvaluationPeriods arithmetic
 * uniform across signals with different publish rates.
 */
const ALARM_PERIOD_SECONDS = 300;

/**
 * Floor on the sustained-idle window. A window shorter than this produces
 * false positives on anything interactive, so a smaller tag value is clamped up.
 */
const MIN_IDLE_DURATION_MINUTES = 30;

/** Defaults for each field of the autostate:idle-threshold tag. */
const DEFAULT_IDLE_DURATION_MINUTES = 60;
const DEFAULT_IDLE_GRACE_MINUTES = 30;
const DEFAULT_IDLE_CPU_MAX_PERCENT = 3;
const DEFAULT_IDLE_NETWORK_MAX = '1MB';
const DEFAULT_IDLE_CONNECTIONS_MAX = 'auto';

/**
 * Positional field order of the autostate:idle-threshold tag.
 *
 * The whole point of the single-tag form is that a user configures idle
 * detection with at most two tags, so the cost is that the values are
 * positional and therefore not self-describing. Two consequences follow:
 *
 * - This array is the ONLY definition of the order. Never reorder it, because
 *   existing tags in the wild would silently change meaning. New fields may
 *   only be appended.
 * - Parsing is deliberately tolerant: fewer fields than this array is fine
 *   (the rest default), and a blank field takes its default. That is what makes
 *   "90" and "60/30/3//auto" both valid.
 */
const IDLE_THRESHOLD_FIELDS = [
  'duration',
  'grace',
  'cpu-max',
  'network-max',
  'connections-max',
] as const;

type IdleThresholdField = (typeof IDLE_THRESHOLD_FIELDS)[number];

/**
 * The value used for any field left blank or omitted.
 *
 * Note the semantic shift this creates versus per-signal tags: because every
 * field has a default, every signal is now ACTIVE by default. Tagging an
 * instance with only autostate:idle-detection=enabled arms CPU, network and
 * connections. Opting a signal out is explicit, via the "off" sentinel.
 */
const IDLE_THRESHOLD_DEFAULTS: Record<IdleThresholdField, string> = {
  'duration': String(DEFAULT_IDLE_DURATION_MINUTES),
  'grace': String(DEFAULT_IDLE_GRACE_MINUTES),
  'cpu-max': String(DEFAULT_IDLE_CPU_MAX_PERCENT),
  'network-max': DEFAULT_IDLE_NETWORK_MAX,
  'connections-max': DEFAULT_IDLE_CONNECTIONS_MAX,
};

/**
 * Field value that asks us to derive a threshold from observed history instead
 * of taking a literal number. See calibrateConnectionThreshold.
 */
const AUTO_THRESHOLD = 'auto';

/**
 * Field value that disables a signal outright, so no child alarm is created
 * for it.
 *
 * This is needed because a blank field means "default" rather than "unset", so
 * without a sentinel there would be no way to turn a signal off. It matters
 * most for connections, which requires the CloudWatch agent - an instance
 * without the agent must be able to say so. Note that turning connections off
 * then trips the connection-signal rule in reconcileInstance and downgrades the
 * instance to notify-only, which is the intended incentive.
 */
const OFF_THRESHOLD = 'off';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Value of the autostate:idle-detection tag. */
type IdleDetectionMode = 'enabled' | 'notify-only' | 'disabled';

/**
 * A signal is one metric we are willing to treat as evidence of activity.
 *
 * "kind" matters for policy, not for the alarm itself: resource signals (CPU,
 * network, disk) are ambiguous on a box with no load balancer in front of it,
 * because a box can sit at 1% CPU while someone reads logs over SSH. A
 * connection signal is much closer to "a human or a process is actually using
 * this", so we refuse to auto-stop without at least one of them configured.
 */
interface IdleSignal {
  /** Short slug used in the child alarm name. Must be stable across deploys. */
  readonly key: string;
  readonly namespace: string;
  readonly metricName: string;
  /**
   * Optional on purpose. CloudWatch treats the unit as part of a metric's
   * identity, so specifying the wrong one silently matches no data. Set it only
   * for metrics whose unit is known (the native AWS/EC2 ones); leave it unset
   * for CloudWatch agent metrics, where it depends on agent configuration.
   */
  readonly unit?: StandardUnit;
  /** Field of autostate:idle-threshold that carries this signal's threshold. */
  readonly thresholdField: IdleThresholdField;
  /** True when the metric only exists if the CloudWatch agent is installed. */
  readonly requiresAgent: boolean;
  readonly kind: 'resource' | 'connection';
  /** Converts the raw tag value into a numeric threshold. */
  readonly parse: (raw: string) => number;
  /** Human-readable description, written into the alarm for the console. */
  readonly description: string;
}

/** A signal that has an actual resolved threshold and is therefore in play. */
interface ResolvedSignal {
  readonly signal: IdleSignal;
  readonly threshold: number;
}

/**
 * Outcome of resolving every signal for one instance.
 *
 * The unresolved list exists because a signal that cannot be resolved must NOT
 * be quietly dropped. Each child alarm is a term in the composite's AND, so
 * removing one leaves fewer conditions to satisfy and makes the composite fire
 * MORE readily - the opposite of safe. Anything unresolvable therefore forces
 * the instance into notify-only instead.
 */
interface SignalResolution {
  readonly resolved: ResolvedSignal[];
  /** Human-readable "<signal key> (<why>)" entries. */
  readonly unresolved: string[];
}

/** Parsed autostate:* configuration for one instance. */
interface IdleConfig {
  readonly mode: IdleDetectionMode;
  readonly idleDurationMinutes: number;
  readonly graceMinutes: number;
  /** Resolved autostate:idle-threshold fields, defaults already filled in. */
  readonly fields: Record<IdleThresholdField, string>;
  /** Parsed autostate:hold-until, if present. */
  readonly holdUntil?: HoldUntil;
}

/**
 * Result of parsing autostate:hold-until. Unparseable values are represented as
 * held rather than ignored, on the basis that someone who typos the tag that is
 * supposed to protect their instance should still get protection.
 */
interface HoldUntil {
  readonly held: boolean;
  readonly detail: string;
}

/** One guard evaluation, recorded so the decision is explainable after the fact. */
interface Guard {
  readonly name: string;
  /** True means this guard blocks the stop. */
  readonly tripped: boolean;
  readonly detail: string;
}

/**
 * Returned by the verify path. The execute / action / resource fields are the
 * contract with the existing ActionRouter; everything else exists so that a
 * human (or a Logs Insights query) can answer "why did this stop, or not stop".
 */
interface IdleStopDecision {
  readonly execute: boolean;
  readonly action: 'stop';
  readonly reason: string;
  readonly resource: {
    readonly type: 'ec2-instance';
    readonly id: string;
    readonly state: string;
    readonly launchTime?: string;
  };
  readonly alarmName: string;
  readonly evaluatedAt: string;
  readonly mode: IdleDetectionMode;
  readonly guards: Guard[];
}

/** Outcome of reconciling one instance, useful for the sweep summary. */
interface ReconcileResult {
  readonly instanceId: string;
  readonly outcome: 'created' | 'deleted' | 'skipped';
  readonly reason: string;
  readonly signalKeys: string[];
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/**
 * Splits an array into fixed size batches. Several CloudWatch and EC2 APIs cap
 * the number of items per request (DeleteAlarms at 100 names, for example), so
 * batching is needed in more than one place.
 */
export function chunk<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}

/**
 * Flattens EC2 tags into a plain lookup.
 *
 * scheduler.mts uses a hardcoded allowlist per service, which means adding a
 * tag requires touching several reduce blocks. Since every tag we care about
 * shares a prefix, a plain map plus prefix lookups is simpler and lets new
 * threshold tags be added by editing only the signal catalog.
 */
export function tagMap(tags?: Tag[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const tag of tags ?? []) {
    if (tag.Key !== undefined && tag.Value !== undefined) {
      map[tag.Key] = tag.Value.trim();
    }
  }
  return map;
}

/**
 * Parses a byte threshold, accepting either a bare number of bytes or a short
 * human-readable suffix, so a tag can read "10MB" instead of "10485760".
 */
export function parseBytes(raw: string): number {
  const match = /^([0-9]*\.?[0-9]+)\s*(B|KB|MB|GB|TB)?$/i.exec(raw.trim());
  if (!match) {
    throw new Error(`Invalid byte value: ${raw}`);
  }
  const value = Number(match[1]);
  const multipliers: Record<string, number> = {
    B: 1,
    KB: 1024,
    MB: 1024 * 1024,
    GB: 1024 * 1024 * 1024,
    TB: 1024 * 1024 * 1024 * 1024,
  };
  // No suffix is treated as raw bytes.
  const suffix = (match[2] ?? 'B').toUpperCase();
  return value * multipliers[suffix];
}

/** Parses a plain non-negative number, rejecting junk rather than yielding NaN. */
export function parseCount(raw: string): number {
  const value = Number(raw.trim());
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid numeric value: ${raw}`);
  }
  return value;
}

/** Parses a percentage and clamps it into 0-100. */
export function parsePercent(raw: string): number {
  const value = parseCount(raw);
  return Math.min(100, value);
}

// ---------------------------------------------------------------------------
// Signal catalog
// ---------------------------------------------------------------------------

/**
 * Every signal we know how to build a child alarm for.
 *
 * The catalog is scoped to the three threshold fields, which means four alarms:
 * network-max drives both NetworkIn and NetworkOut, because nobody wants to set
 * those separately.
 *
 * Deliberately NOT here, and why:
 *
 * - Memory (mem_used_percent) is the weakest available idle signal. Memory stays
 *   allocated long after work finishes, so a JVM that finished a job hours ago
 *   still reports high usage and would hold an idle box open indefinitely.
 *
 * - Packets (NetworkPacketsIn/Out) would catch an open-but-quiet session that
 *   moves almost no bytes while exchanging keepalives. The connection signal
 *   below covers that case directly and more cheaply, so packets are redundant.
 *
 * - Disk ops (EBSReadOps/EBSWriteOps) are only published on Nitro instance
 *   types. On older families the metric never appears at all, which combined
 *   with the missing-data treatment means the child never enters ALARM and the
 *   composite can never fire - failing safe, but silently, which is worse than
 *   not offering the signal.
 *
 * On the connection signal: tcp_established is the strongest single signal on a
 * bare EC2 box, but its floor is NOT zero. The SSM agent holds a persistent
 * long-poll connection and the CloudWatch agent holds its own, so a genuinely
 * idle instance sits at some small nonzero number that varies by AMI. That is
 * why "auto" is the default for this field rather than a literal number.
 */
export const IDLE_SIGNALS: IdleSignal[] = [
  {
    key: 'cpu',
    namespace: 'AWS/EC2',
    metricName: 'CPUUtilization',
    unit: StandardUnit.Percent,
    thresholdField: 'cpu-max',
    requiresAgent: false,
    kind: 'resource',
    parse: parsePercent,
    description: 'CPU utilization is below the idle threshold',
  },
  {
    key: 'net-in',
    namespace: 'AWS/EC2',
    metricName: 'NetworkIn',
    unit: StandardUnit.Bytes,
    thresholdField: 'network-max',
    requiresAgent: false,
    kind: 'resource',
    parse: parseBytes,
    description: 'Inbound network bytes are below the idle threshold',
  },
  {
    key: 'net-out',
    namespace: 'AWS/EC2',
    metricName: 'NetworkOut',
    unit: StandardUnit.Bytes,
    thresholdField: 'network-max',
    requiresAgent: false,
    kind: 'resource',
    parse: parseBytes,
    description: 'Outbound network bytes are below the idle threshold',
  },
  {
    key: 'conn',
    namespace: 'CWAgent',
    metricName: 'netstat_tcp_established',
    thresholdField: 'connections-max',
    requiresAgent: true,
    kind: 'connection',
    parse: parseCount,
    description: 'Established TCP connections are at or below the idle floor',
  },
];

// ---------------------------------------------------------------------------
// Alarm naming
// ---------------------------------------------------------------------------

/** Composite alarm name for an instance. This is what EventBridge matches on. */
export function compositeAlarmName(instanceId: string): string {
  return `${COMPOSITE_ALARM_PREFIX}${instanceId}`;
}

/** Child alarm name for one signal on one instance. */
export function signalAlarmName(instanceId: string, signalKey: string): string {
  return `${SIGNAL_ALARM_PREFIX}${instanceId}-${signalKey}`;
}

/** Prefix that matches every child alarm belonging to one instance. */
function signalAlarmPrefix(instanceId: string): string {
  return `${SIGNAL_ALARM_PREFIX}${instanceId}-`;
}

/**
 * Recovers the instance id from a managed alarm name.
 *
 * We deliberately read the id out of the name rather than out of the alarm
 * state change event payload. The payload's dimension data is not guaranteed to
 * be present in a shape we can rely on, whereas the name is something we control
 * and which also gives PutMetricAlarm its idempotency.
 */
export function instanceIdFromAlarmName(alarmName: string): string | undefined {
  if (alarmName.startsWith(COMPOSITE_ALARM_PREFIX)) {
    return alarmName.slice(COMPOSITE_ALARM_PREFIX.length) || undefined;
  }
  if (alarmName.startsWith(SIGNAL_ALARM_PREFIX)) {
    // Child names are <prefix><instanceId>-<signalKey>, and instance ids never
    // contain a hyphen after the "i-" stem, so strip the trailing signal slug.
    const remainder = alarmName.slice(SIGNAL_ALARM_PREFIX.length);
    const parts = remainder.split('-');
    return parts.length >= 2 ? `${parts[0]}-${parts[1]}` : undefined;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Tag parsing
// ---------------------------------------------------------------------------

/** Reads a prefixed tag, e.g. suffix "idle-threshold" -> "autostate:idle-threshold". */
function readTag(
  tags: Record<string, string>,
  suffix: string,
): string | undefined {
  const value = tags[`${TAG_PREFIX}${suffix}`];
  return value === undefined || value === '' ? undefined : value;
}

/**
 * Parses autostate:hold-until, the user-facing escape hatch that pins an
 * instance running.
 *
 * This tag is intentionally not part of any tag hash. scheduler.mts derives its
 * Step Functions execution names from hashTagsV1, so if hold-until fed into that
 * hash then pinning an instance would invalidate every already-scheduled
 * execution for it.
 */
export function parseHoldUntil(raw: string | undefined): HoldUntil | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const when = new Date(raw);
  if (Number.isNaN(when.getTime())) {
    // Fail-safe: an unparseable hold tag protects the instance rather than
    // being silently discarded.
    return {held: true, detail: `Unparseable hold-until value "${raw}"`};
  }
  const held = when.getTime() > Date.now();
  return {
    held,
    detail: held
      ? `Held until ${when.toISOString()}`
      : `Hold expired at ${when.toISOString()}`,
  };
}

/**
 * Splits the positional autostate:idle-threshold tag into named fields.
 *
 * Every field starts at its default and is only overwritten by a non-blank
 * value, which gives all three tolerances the single-tag form needs:
 *
 *   undefined         -> all defaults
 *   "90"              -> duration 90, rest default (short form)
 *   "60/30/3//auto"   -> blank network-max takes its default (skipped form)
 *
 * Values are kept as raw strings here rather than parsed, so a malformed field
 * can be attributed to its own signal later in resolveSignals.
 */
export function parseIdleThresholdTag(
  raw: string | undefined,
): Record<IdleThresholdField, string> {
  const fields: Record<IdleThresholdField, string> = {
    ...IDLE_THRESHOLD_DEFAULTS,
  };
  if (raw === undefined) {
    return fields;
  }
  const parts = raw.split('/');
  if (parts.length > IDLE_THRESHOLD_FIELDS.length) {
    // Extra fields are almost certainly a typo. Ignoring them is non-fatal, but
    // it must be visible or the user will believe a value took effect.
    console.log(
      `${TAG_PREFIX}idle-threshold has ${parts.length} fields but only ` +
        `${IDLE_THRESHOLD_FIELDS.length} are defined ` +
        `(${IDLE_THRESHOLD_FIELDS.join('/')}); ignoring the extras`,
    );
  }
  IDLE_THRESHOLD_FIELDS.forEach((field, index) => {
    const value = parts[index]?.trim();
    if (value !== undefined && value !== '') {
      fields[field] = value;
    }
  });
  return fields;
}

/**
 * Parses a duration field, falling back to the default rather than failing.
 *
 * Falling back is safe here in a way it is not for signal thresholds: duration
 * and grace do not add or remove terms from the composite's AND, so a bad value
 * defaulting cannot make the alarm easier to trigger. A bad signal threshold, by
 * contrast, forces notify-only - see SignalResolution.
 */
function minutesOrDefault(
  raw: string,
  fallback: number,
  label: string,
): number {
  try {
    return parseCount(raw);
  } catch {
    console.log(
      `Invalid ${label} value "${raw}" in ${TAG_PREFIX}idle-threshold, ` +
        `using default ${fallback}`,
    );
    return fallback;
  }
}

/** Parses the whole autostate:* idle configuration off an instance's tags. */
export function parseIdleConfig(tags: Record<string, string>): IdleConfig {
  const rawMode = readTag(tags, 'idle-detection')?.toLowerCase();
  const mode: IdleDetectionMode =
    rawMode === 'enabled' || rawMode === 'true'
      ? 'enabled'
      : rawMode === 'notify-only'
        ? 'notify-only'
        : 'disabled';

  const fields = parseIdleThresholdTag(readTag(tags, 'idle-threshold'));

  // The sustained window is clamped up to the floor rather than rejected, so a
  // careless "5" degrades to something safe instead of failing the reconcile.
  const idleDurationMinutes = Math.max(
    MIN_IDLE_DURATION_MINUTES,
    minutesOrDefault(
      fields['duration'],
      DEFAULT_IDLE_DURATION_MINUTES,
      'duration',
    ),
  );

  const graceMinutes = minutesOrDefault(
    fields['grace'],
    DEFAULT_IDLE_GRACE_MINUTES,
    'grace',
  );

  return {
    mode,
    idleDurationMinutes,
    graceMinutes,
    fields,
    holdUntil: parseHoldUntil(readTag(tags, 'hold-until')),
  };
}

// ---------------------------------------------------------------------------
// Threshold resolution
// ---------------------------------------------------------------------------

/**
 * Measures the observed floor of a connection metric so we can set a threshold
 * just above it.
 *
 * This exists because tcp_established never reaches zero on a real instance -
 * the SSM and CloudWatch agents each hold a persistent connection - and that
 * floor is AMI and agent dependent, so no global default is correct. Asking
 * CloudWatch for the Minimum over the last week gives us the quietest the box
 * has ever been, which is a far better basis than a guess.
 *
 * Called only when the threshold tag is set to "auto".
 */
async function calibrateConnectionThreshold(
  instanceId: string,
  signal: IdleSignal,
): Promise<number | undefined> {
  const endTime = new Date();
  const startTime = new Date(endTime.getTime() - 7 * 24 * 60 * 60 * 1000);
  const output = await cloudWatchClient.send(
    new GetMetricStatisticsCommand({
      Namespace: signal.namespace,
      MetricName: signal.metricName,
      Dimensions: [{Name: 'InstanceId', Value: instanceId}],
      StartTime: startTime,
      EndTime: endTime,
      // One hour buckets keep the response small; we only want the floor.
      Period: 3600,
      Statistics: [Statistic.Minimum],
      Unit: signal.unit,
    }),
  );
  const minimums = (output.Datapoints ?? [])
    .map((point) => point.Minimum)
    .filter((value): value is number => value !== undefined);
  if (minimums.length === 0) {
    // No history means either the agent is not reporting or the instance is new.
    // We return undefined rather than inventing a threshold, which the caller
    // treats as unresolvable and therefore forces notify-only. A brand-new
    // instance consequently observes for a while before it can ever be stopped.
    return undefined;
  }
  const floor = Math.min(...minimums);
  // The threshold sits one above the floor so the alarm fires when the instance
  // is at its quietest observed state and nothing more is connected.
  return floor + 1;
}

/**
 * Turns the idle-threshold fields into signals with numeric thresholds.
 *
 * Since every field now carries a default, a signal is in play unless it is
 * explicitly switched off. There are therefore three outcomes per signal:
 *
 * - "off": the user opted out. Not an error, and no child alarm is created.
 * - resolved: a numeric threshold was obtained, literally or by calibration.
 * - unresolved: the value is configured but unusable (malformed, or calibration
 *   found no history). Reported to the caller, never silently dropped, because
 *   dropping a child removes a term from the composite's 'AND' and makes it fire
 *   more readily.
 *
 * Nothing here throws. Throwing would abandon the whole reconcile and leave the
 * instance carrying a stale alarm set, which is worse than arming conservatively.
 */
export async function resolveSignals(
  instanceId: string,
  config: IdleConfig,
): Promise<SignalResolution> {
  const resolved: ResolvedSignal[] = [];
  const unresolved: string[] = [];
  for (const signal of IDLE_SIGNALS) {
    const raw = config.fields[signal.thresholdField];
    const normalized = raw.toLowerCase();

    // Explicit opt-out. The connection-signal rule in reconcileInstance still
    // applies, so switching connections off costs the ability to auto-stop.
    if (normalized === OFF_THRESHOLD) {
      console.log(`Signal ${signal.key} on ${instanceId} is off`);
      continue;
    }

    if (normalized === AUTO_THRESHOLD) {
      if (signal.kind !== 'connection') {
        unresolved.push(
          `${signal.key} ("auto" is only supported for connection signals)`,
        );
        continue;
      }
      const calibrated = await calibrateConnectionThreshold(instanceId, signal);
      if (calibrated === undefined) {
        unresolved.push(
          `${signal.key} (no metric history to calibrate against)`,
        );
        continue;
      }
      console.log(
        `Calibrated ${signal.key} threshold for ${instanceId} to ${calibrated}`,
      );
      resolved.push({signal, threshold: calibrated});
      continue;
    }

    try {
      resolved.push({signal, threshold: signal.parse(raw)});
    } catch (err) {
      unresolved.push(`${signal.key} (${(err as Error).message})`);
    }
  }
  return {resolved, unresolved};
}

// ---------------------------------------------------------------------------
// Alarm construction
// ---------------------------------------------------------------------------

/**
 * Number of consecutive 5 minute periods that make up the sustained window.
 * A 60-minute window becomes 12 periods.
 */
function evaluationPeriods(idleDurationMinutes: number): number {
  return Math.max(
    1,
    Math.ceil((idleDurationMinutes * 60) / ALARM_PERIOD_SECONDS),
  );
}

/**
 * Creates or updates the child alarm for one signal.
 *
 * Three settings carry the safety properties of the whole design:
 *
 * - ComparisonOperator is LessThanThreshold, so the alarm is phrased as "this
 *   signal is LOW" and ALARM means idle. The polarity is inverted relative to a
 *   normal monitoring alarm, and it is easy to misread.
 *
 * - TreatMissingData is "notBreaching", meaning a gap in the metric keeps this
 *   child OUT of alarm. If the CloudWatch agent dies, its metrics stop, those
 *   children go quiet, and the composite can never fire. A broken monitoring
 *   agent therefore prevents stops rather than causing them. This is the single
 *   most important field in this function.
 *
 * - DatapointsToAlarm equals EvaluationPeriods, so every period in the window
 *   must breach. Combined with notBreaching above, this means a single missing
 *   datapoint anywhere in the window prevents the alarm - which gives us a full
 *   data-coverage requirement for free, declaratively, instead of counting
 *   datapoints ourselves.
 */
async function putSignalAlarm(
  instanceId: string,
  resolved: ResolvedSignal,
  config: IdleConfig,
): Promise<string> {
  const periods = evaluationPeriods(config.idleDurationMinutes);
  const alarmName = signalAlarmName(instanceId, resolved.signal.key);
  await cloudWatchClient.send(
    new PutMetricAlarmCommand({
      AlarmName: alarmName,
      AlarmDescription:
        `AutoState idle signal for ${instanceId}: ${resolved.signal.description}. ` +
        'Managed automatically - edit the instance tags instead of this alarm.',
      Namespace: resolved.signal.namespace,
      MetricName: resolved.signal.metricName,
      Dimensions: [{Name: 'InstanceId', Value: instanceId}],
      // Maximum, not Average: a short burst of genuine work must not be
      // smoothed away into looking idle.
      Statistic: Statistic.Maximum,
      Unit: resolved.signal.unit,
      Period: ALARM_PERIOD_SECONDS,
      EvaluationPeriods: periods,
      DatapointsToAlarm: periods,
      ComparisonOperator: ComparisonOperator.LessThanThreshold,
      Threshold: resolved.threshold,
      TreatMissingData: 'notBreaching',
      // Children never act on their own; only the composite is wired to
      // anything. Disabling actions here makes that explicit and prevents a
      // later change from accidentally giving a single signal the power to stop
      // an instance. Composite alarms still read child state regardless.
      ActionsEnabled: false,
      Tags: [
        {Key: `${TAG_PREFIX}managed`, Value: 'true'},
        {Key: `${TAG_PREFIX}instance-id`, Value: instanceId},
      ],
    }),
  );
  return alarmName;
}

/**
 * Creates or updates the composite alarm that ANDs the child alarms together.
 *
 * The composite is the only alarm anything listens to. It enters ALARM when
 * every configured signal has been below its threshold for the entire window,
 * and CloudWatch emits an EventBridge state change event when it does.
 *
 * ActionsEnabled is true here even though we attach no AlarmActions: the
 * EventBridge event is what we consume, and leaving actions enabled avoids any
 * ambiguity about whether state change notifications are suppressed.
 */
async function putCompositeAlarm(
  instanceId: string,
  childAlarmNames: string[],
  config: IdleConfig,
): Promise<string> {
  const alarmName = compositeAlarmName(instanceId);
  // ALARM("a") AND ALARM("b") AND ... - every child must be idle at once.
  const rule = childAlarmNames.map((name) => `ALARM("${name}")`).join(' AND ');
  await cloudWatchClient.send(
    new PutCompositeAlarmCommand({
      AlarmName: alarmName,
      AlarmDescription:
        `AutoState idle detection for ${instanceId}. Fires when all ${childAlarmNames.length} ` +
        `signals stay below threshold for ${config.idleDurationMinutes} minutes. ` +
        `Mode: ${config.mode}. Managed automatically - edit the instance tags instead.`,
      AlarmRule: rule,
      ActionsEnabled: true,
      Tags: [
        {Key: `${TAG_PREFIX}managed`, Value: 'true'},
        {Key: `${TAG_PREFIX}instance-id`, Value: instanceId},
      ],
    }),
  );
  return alarmName;
}

// ---------------------------------------------------------------------------
// Alarm discovery and teardown
// ---------------------------------------------------------------------------

/** Lists managed alarm names under a prefix, following pagination. */
async function listAlarmNames(
  prefix: string,
  alarmTypes: AlarmType[],
): Promise<string[]> {
  const names: string[] = [];
  let nextToken: string | undefined = undefined;
  do {
    // The output type is annotated rather than inferred: nextToken is both an
    // input to this call and assigned from its result, and without the
    // annotation that round trip makes send()'s generic inference circular.
    const output: DescribeAlarmsCommandOutput = await cloudWatchClient.send(
      new DescribeAlarmsCommand({
        AlarmNamePrefix: prefix,
        AlarmTypes: alarmTypes,
        NextToken: nextToken,
      }),
    );
    for (const alarm of output.MetricAlarms ?? []) {
      if (alarm.AlarmName !== undefined) {
        names.push(alarm.AlarmName);
      }
    }
    for (const alarm of output.CompositeAlarms ?? []) {
      if (alarm.AlarmName !== undefined) {
        names.push(alarm.AlarmName);
      }
    }
    nextToken = output.NextToken;
  } while (nextToken !== undefined);
  return names;
}

/**
 * Deletes alarms in batches. DeleteAlarms accepts at most 100 names per call.
 *
 * Note that deleting a composite before its children is fine, but deleting a
 * child that a live composite still references is not - CloudWatch rejects it.
 * Callers must therefore remove the composite first, which deleteInstanceAlarms
 * below does.
 */
async function deleteAlarms(alarmNames: string[]): Promise<void> {
  for (const batch of chunk(alarmNames, 100)) {
    if (batch.length > 0) {
      await cloudWatchClient.send(new DeleteAlarmsCommand({AlarmNames: batch}));
    }
  }
}

/**
 * Removes every alarm we manage for an instance.
 *
 * Order matters: the composite goes first because CloudWatch refuses to delete
 * a metric alarm that a composite alarm rule still references.
 */
export async function deleteInstanceAlarms(instanceId: string): Promise<void> {
  await deleteAlarms([compositeAlarmName(instanceId)]);
  const children = await listAlarmNames(signalAlarmPrefix(instanceId), [
    AlarmType.MetricAlarm,
  ]);
  await deleteAlarms(children);
  console.log(
    `Deleted ${children.length + 1} alarms for ${instanceId} (composite + ${children.length} signals)`,
  );
}

// ---------------------------------------------------------------------------
// Reconcile
// ---------------------------------------------------------------------------

/**
 * Makes the alarm set for one instance match its tags.
 *
 * This is idempotent by design - PutMetricAlarm and PutCompositeAlarm are both
 * upserts keyed on the alarm name - so it is safe to call from any trigger and
 * safe to call repeatedly. That is what lets a periodic sweep repair drift
 * without needing to track what it has already done.
 *
 * Note that this function never writes tags. If it did, the tag change rule in
 * autostate-construct.ts would fire on our own writes, and we would have built a
 * reconcile loop that feeds itself.
 */
export async function reconcileInstance(
  instance: Instance,
): Promise<ReconcileResult> {
  const instanceId = instance.InstanceId;
  if (instanceId === undefined) {
    return {
      instanceId: 'unknown',
      outcome: 'skipped',
      reason: 'Instance has no id',
      signalKeys: [],
    };
  }

  const tags = tagMap(instance.Tags);
  const config = parseIdleConfig(tags);

  // Opted out, or never opted in: tear down anything we previously created so
  // removing the tag is a complete off switch and does not leak paid alarms.
  if (config.mode === 'disabled') {
    await deleteInstanceAlarms(instanceId);
    return {
      instanceId,
      outcome: 'deleted',
      reason: 'Idle detection is disabled or not tagged',
      signalKeys: [],
    };
  }

  const {resolved, unresolved} = await resolveSignals(instanceId, config);
  if (resolved.length === 0) {
    // A composite with no children would be meaningless, and an empty AlarmRule
    // is rejected outright, so clean up instead. Reachable by switching every
    // signal off.
    await deleteInstanceAlarms(instanceId);
    return {
      instanceId,
      outcome: 'deleted',
      reason: 'No usable signal thresholds are configured',
      signalKeys: [],
    };
  }

  // Two independent reasons to refuse to arm, both of which downgrade to
  // notify-only rather than failing. The alarms are still written either way, so
  // the operator keeps full observability while carrying none of the risk.
  const downgradeReasons: string[] = [];

  // 1. Resource metrics alone are not sufficient evidence. CPU and network on an
  //    instance with no load balancer in front of it cannot distinguish "nobody
  //    is here" from "somebody is here and reading logs".
  const hasConnectionSignal = resolved.some(
    (entry) => entry.signal.kind === 'connection',
  );
  if (!hasConnectionSignal) {
    downgradeReasons.push(
      'no connection signal is configured (the connections-max field of ' +
        `${TAG_PREFIX}idle-threshold is off or unusable), and resource metrics ` +
        'alone are not sufficient evidence to stop an instance',
    );
  }

  // 2. A configured signal could not be resolved. Arming anyway would build a
  //    composite with fewer terms in its "AND" than the user asked for, which
  //    fires more readily than intended - so this is treated as unsafe, not as
  //    a minor degradation.
  if (unresolved.length > 0) {
    downgradeReasons.push(
      `these configured signals could not be resolved: ${unresolved.join('; ')}`,
    );
  }

  const effectiveMode: IdleDetectionMode =
    config.mode === 'enabled' && downgradeReasons.length > 0
      ? 'notify-only'
      : config.mode;
  if (effectiveMode !== config.mode) {
    console.log(
      `Downgrading ${instanceId} to notify-only: ${downgradeReasons.join(' | ')}`,
    );
  }
  const effectiveConfig: IdleConfig = {...config, mode: effectiveMode};

  // Write the children first so they exist before the composite references
  // them; a composite rule naming an absent alarm is rejected.
  const childNames: string[] = [];
  for (const entry of resolved) {
    childNames.push(await putSignalAlarm(instanceId, entry, effectiveConfig));
  }
  await putCompositeAlarm(instanceId, childNames, effectiveConfig);

  // Remove children left over from a previous configuration, e.g. a threshold
  // tag that has since been deleted. Done after the composite is rewritten so
  // it no longer references anything we are about to remove.
  const existing = await listAlarmNames(signalAlarmPrefix(instanceId), [
    AlarmType.MetricAlarm,
  ]);
  const stale = existing.filter((name) => !childNames.includes(name));
  if (stale.length > 0) {
    console.log(
      `Removing ${stale.length} stale signal alarms for ${instanceId}`,
    );
    await deleteAlarms(stale);
  }

  const signalKeys = resolved.map((entry) => entry.signal.key);
  console.log(
    `Reconciled ${instanceId} in ${effectiveMode} mode with signals ` +
      `[${signalKeys.join(', ')}] over ${effectiveConfig.idleDurationMinutes} minutes`,
  );
  return {
    instanceId,
    outcome: 'created',
    reason: `Armed in ${effectiveMode} mode`,
    signalKeys,
  };
}

// ---------------------------------------------------------------------------
// Instance discovery
// ---------------------------------------------------------------------------

/**
 * Describes instances by id.
 *
 * Uses the instance-id filter rather than the InstanceIds parameter on purpose:
 * InstanceIds throws InvalidInstanceID.NotFound if ANY id in the list is gone,
 * which would break a batch lookup exactly when we are trying to find out which
 * ids are gone. The filter form simply omits missing instances.
 */
async function describeInstancesByIds(
  instanceIds: string[],
): Promise<Instance[]> {
  const instances: Instance[] = [];
  // DescribeInstances filters accept up to 200 values, so batch conservatively.
  for (const batch of chunk(instanceIds, 100)) {
    let nextToken: string | undefined = undefined;
    do {
      // Annotated for the same reason as listAlarmNames above: nextToken feeds
      // this call and is reassigned from its result.
      const output: DescribeInstancesCommandOutput = await ec2Client.send(
        new DescribeInstancesCommand({
          Filters: [{Name: 'instance-id', Values: batch}],
          NextToken: nextToken,
        }),
      );
      for (const reservation of output.Reservations ?? []) {
        instances.push(...(reservation.Instances ?? []));
      }
      nextToken = output.NextToken;
    } while (nextToken !== undefined);
  }
  return instances;
}

/**
 * Finds every instance that has opted in to idle detection.
 *
 * Stopped instances are included deliberately. Their metrics stop flowing, which
 * (via notBreaching) keeps the children out of alarm, so their alarms are inert
 * and harmless. Leaving them in place avoids tearing down and rebuilding the
 * whole alarm set on every stop/start cycle.
 */
async function describeTaggedInstances(): Promise<Instance[]> {
  const instances: Instance[] = [];
  let nextToken: string | undefined = undefined;
  do {
    // Annotated for the same reason as listAlarmNames above: nextToken feeds
    // this call and is reassigned from its result.
    const output: DescribeInstancesCommandOutput = await ec2Client.send(
      new DescribeInstancesCommand({
        Filters: [
          {Name: 'tag-key', Values: [`${TAG_PREFIX}idle-detection`]},
          {Name: 'instance-state-name', Values: ['running', 'stopped']},
        ],
        NextToken: nextToken,
      }),
    );
    for (const reservation of output.Reservations ?? []) {
      instances.push(...(reservation.Instances ?? []));
    }
    nextToken = output.NextToken;
  } while (nextToken !== undefined);
  return instances;
}

// ---------------------------------------------------------------------------
// Sweep
// ---------------------------------------------------------------------------

/**
 * Periodic drift repair. Intended to run infrequently - daily is plenty.
 *
 * Event driven reconcile handles the normal cases, but it cannot cover a failed
 * API call, an alarm somebody edited by hand, or an instance that was terminated
 * while this Lambda was throttled. Since reconcileInstance is idempotent, the
 * cheapest correct repair is simply to run it over everything.
 *
 * The second half is orphan cleanup, and it is deliberately cautious. Rather
 * than deleting alarms for any instance id missing from the tagged set - which
 * would delete live alarms if DescribeInstances returned partial results - each
 * candidate id is looked up explicitly and only removed on confirmed absence,
 * termination, or opt-out.
 */
export async function sweep(): Promise<ReconcileResult[]> {
  const results: ReconcileResult[] = [];

  const tagged = await describeTaggedInstances();
  console.log(`Sweep found ${tagged.length} tagged instances`);
  for (const instance of tagged) {
    try {
      results.push(await reconcileInstance(instance));
    } catch (err) {
      // One bad instance must not abort the sweep for everything after it.
      console.log(
        `Failed to reconcile ${instance.InstanceId}: ${(err as Error).message}`,
      );
    }
  }

  // Every instance id that currently has a managed composite alarm.
  const compositeNames = await listAlarmNames(COMPOSITE_ALARM_PREFIX, [
    AlarmType.CompositeAlarm,
  ]);
  const alarmedIds = compositeNames
    .map((name) => instanceIdFromAlarmName(name))
    .filter((id): id is string => id !== undefined);

  const reconciledIds = new Set(
    results.filter((r) => r.outcome === 'created').map((r) => r.instanceId),
  );
  const candidates = alarmedIds.filter((id) => !reconciledIds.has(id));
  if (candidates.length === 0) {
    return results;
  }

  // Confirm each candidate individually before deleting anything.
  const live = await describeInstancesByIds(candidates);
  const liveById = new Map<string, Instance>();
  for (const instance of live) {
    if (instance.InstanceId !== undefined) {
      liveById.set(instance.InstanceId, instance);
    }
  }

  for (const instanceId of candidates) {
    const instance = liveById.get(instanceId);
    const state = instance?.State?.Name;
    const optedOut =
      instance !== undefined &&
      parseIdleConfig(tagMap(instance.Tags)).mode === 'disabled';
    const gone =
      instance === undefined ||
      state === 'terminated' ||
      state === 'shutting-down';
    if (gone || optedOut) {
      console.log(
        `Cleaning up orphaned alarms for ${instanceId} (${gone ? `state=${state ?? 'absent'}` : 'opted out'})`,
      );
      await deleteInstanceAlarms(instanceId);
      results.push({
        instanceId,
        outcome: 'deleted',
        reason: gone ? 'Instance no longer exists' : 'Instance opted out',
        signalKeys: [],
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------

/**
 * Guards that a CloudWatch alarm cannot possibly know about.
 *
 * The composite alarm proves one thing only: the metrics look idle. It knows
 * nothing about tags, autoscaling membership, instance lifecycle, or how long
 * ago the box booted. So the alarm is a candidate detector, not a decision, and
 * everything that makes stopping unsafe is checked here at action time.
 *
 * Every guard is recorded whether it tripped or not, so the returned decision
 * explains itself without needing a second investigation.
 */
export function evaluateGuards(
  instance: Instance,
  config: IdleConfig,
  now: Date,
): Guard[] {
  const guards: Guard[] = [];
  const tags = tagMap(instance.Tags);

  // The instance must still be running. An alarm can fire moments after
  // somebody stopped the instance by hand.
  const state = instance.State?.Name ?? 'unknown';
  guards.push({
    name: 'instance-running',
    tripped: state !== 'running',
    detail: `Instance state is ${state}`,
  });

  // User-set pin. The most important guard for adoption: without a working
  // "leave my box alone" button people defeat idle detection with busy loops.
  guards.push({
    name: 'hold-until',
    tripped: config.holdUntil?.held === true,
    detail: config.holdUntil?.detail ?? 'No hold-until tag set',
  });

  // Autoscaling group members must not be stopped - the group sees the instance
  // fail its health check and replaces it, so we would be causing churn rather
  // than saving money.
  const asgName = tags['aws:autoscaling:groupName'];
  guards.push({
    name: 'not-autoscaled',
    tripped: asgName !== undefined,
    detail:
      asgName !== undefined
        ? `Member of autoscaling group ${asgName}`
        : 'Not an autoscaling group member',
  });

  // Spot instances cannot reliably be stopped and restarted; it depends on the
  // request type, and getting it wrong loses the instance.
  const lifecycle = instance.InstanceLifecycle;
  guards.push({
    name: 'not-spot',
    tripped: lifecycle !== undefined,
    detail:
      lifecycle !== undefined
        ? `Instance lifecycle is ${lifecycle}`
        : 'On-demand instance',
  });

  // Stopping destroys instance store data. BlockDeviceMappings from
  // DescribeInstances only lists EBS volumes, so this check is only best effort:
  // it catches an instance-store root device but cannot see attached ephemeral
  // volumes. Anything relying on instance store should also carry an explicit
  // opt-out tag.
  const rootDeviceType = instance.RootDeviceType ?? 'ebs';
  guards.push({
    name: 'ebs-root',
    tripped: rootDeviceType !== 'ebs',
    detail: `Root device type is ${rootDeviceType}`,
  });

  // The alarm window must not straddle a start. LaunchTime reflects the most
  // recent start for an instance that has been stopped and started, so if the
  // box booted less than (window + grace) ago then part of the window either has
  // no data or belongs to a previous run.
  const launchTime = instance.LaunchTime;
  const requiredMinutes = config.idleDurationMinutes + config.graceMinutes;
  if (launchTime === undefined) {
    guards.push({
      name: 'post-start-grace',
      tripped: true,
      detail: 'Instance has no launch time',
    });
  } else {
    const runningMinutes = Math.floor(
      (now.getTime() - launchTime.getTime()) / 60000,
    );
    guards.push({
      name: 'post-start-grace',
      tripped: runningMinutes < requiredMinutes,
      detail:
        `Running for ${runningMinutes} minutes; requires ` +
        `${requiredMinutes} (${config.idleDurationMinutes} window + ${config.graceMinutes} grace)`,
    });
  }

  return guards;
}

/**
 * Handles a composite alarm entering ALARM: re-check the guards and decide.
 *
 * Returns a decision object rather than stopping anything. The execute, action
 * and resource fields match what the existing ActionRouter in
 * autostate-construct.ts routes on, so the state machine performs the stop
 * through the StopEc2Instance task that is already defined there.
 */
export async function verifyIdleStop(
  alarmName: string,
): Promise<IdleStopDecision> {
  const now = new Date();
  const instanceId = instanceIdFromAlarmName(alarmName);

  // Defensive: the EventBridge rule should only ever route composite alarms
  // here, but if the rule is ever widened this stops a single signal alarm from
  // being treated as a full idle verdict.
  if (
    instanceId === undefined ||
    !alarmName.startsWith(COMPOSITE_ALARM_PREFIX)
  ) {
    return {
      execute: false,
      action: 'stop',
      reason: `Alarm ${alarmName} is not a managed composite idle alarm`,
      resource: {
        type: 'ec2-instance',
        id: instanceId ?? 'unknown',
        state: 'unknown',
      },
      alarmName,
      evaluatedAt: now.toISOString(),
      mode: 'disabled',
      guards: [],
    };
  }

  const instances = await describeInstancesByIds([instanceId]);
  if (instances.length === 0) {
    // The instance is gone; take its alarms with it so we stop paying for them.
    await deleteInstanceAlarms(instanceId);
    return {
      execute: false,
      action: 'stop',
      reason: 'Instance no longer exists',
      resource: {type: 'ec2-instance', id: instanceId, state: 'absent'},
      alarmName,
      evaluatedAt: now.toISOString(),
      mode: 'disabled',
      guards: [],
    };
  }

  const instance = instances[0];
  const config = parseIdleConfig(tagMap(instance.Tags));
  const guards = evaluateGuards(instance, config, now);
  const blocking = guards.filter((guard) => guard.tripped);

  const resource = {
    type: 'ec2-instance' as const,
    id: instanceId,
    state: instance.State?.Name ?? 'unknown',
    launchTime: instance.LaunchTime?.toISOString(),
  };

  const decision: IdleStopDecision = {
    execute:
      // Every guard must pass, and notify-only observes without acting. Note
      // that mode is re-read from tags here rather than trusted from the alarm,
      // so flipping the tag to notify-only takes effect immediately even while
      // an alarm is already in ALARM.
      blocking.length === 0 && config.mode === 'enabled',
    action: 'stop',
    reason:
      blocking.length > 0
        ? `Blocked by ${blocking.map((guard) => guard.name).join(', ')}`
        : config.mode === 'enabled'
          ? 'Idle for the full window and all guards passed'
          : `Idle for the full window but mode is ${config.mode}`,
    resource,
    alarmName,
    evaluatedAt: now.toISOString(),
    mode: config.mode,
    guards,
  };

  // Logged as a single JSON line so Logs Insights can answer both "why did this
  // stop" and "what would have stopped if we enabled it", which is what makes
  // notify-only mode useful for threshold tuning.
  console.log(`Idle stop decision: ${JSON.stringify(decision)}`);
  return decision;
}

// ---------------------------------------------------------------------------
// Event handling
// ---------------------------------------------------------------------------

/**
 * Unwraps the event payload.
 *
 * scheduler.mts is invoked from inside Step Functions and reads
 * event.Execution.Input. Whether this handler is wired the same way or invoked
 * directly by EventBridge is still a CDK decision, so both shapes are accepted:
 * if a Step Functions execution context is present we take the input from it,
 * otherwise the event is already the EventBridge payload.
 */
export function unwrapEvent(event: unknown): Record<string, unknown> {
  const candidate = event as {Execution?: {Input?: Record<string, unknown>}};
  if (candidate?.Execution?.Input !== undefined) {
    return candidate.Execution.Input;
  }
  return (event ?? {}) as Record<string, unknown>;
}

/**
 * Reconciles the instances named by an event's resource ARNs.
 *
 * Tag change events carry full ARNs; EC2 state change events carry a bare id in
 * the detail. Both funnel through here.
 */
async function reconcileByIds(instanceIds: string[]): Promise<unknown> {
  if (instanceIds.length === 0) {
    console.log('No instance ids in event, nothing to reconcile');
    return {reconciled: []};
  }
  const instances = await describeInstancesByIds(instanceIds);
  const found = new Set(
    instances
      .map((instance) => instance.InstanceId)
      .filter((id): id is string => id !== undefined),
  );
  const results: ReconcileResult[] = [];
  for (const instance of instances) {
    results.push(await reconcileInstance(instance));
  }
  // An id in the event that DescribeInstances cannot find has been terminated,
  // so remove its alarms rather than leaving them to bill forever.
  for (const instanceId of instanceIds) {
    if (!found.has(instanceId)) {
      await deleteInstanceAlarms(instanceId);
      results.push({
        instanceId,
        outcome: 'deleted',
        reason: 'Instance not found',
        signalKeys: [],
      });
    }
  }
  return {reconciled: results};
}

/** Extracts bare instance ids from EventBridge resource ARNs. */
function instanceIdsFromArns(resources: unknown): string[] {
  if (!Array.isArray(resources)) {
    return [];
  }
  return (
    resources
      .filter((arn): arn is string => typeof arn === 'string')
      // arn:aws:ec2:<region>:<account>:instance/i-0abc123
      .map((arn) => arn.substring(arn.lastIndexOf('/') + 1))
      .filter((id) => id.startsWith('i-'))
  );
}

/**
 * Lambda entry point.
 *
 * Routes on the EventBridge detail-type, mapping each trigger to one of the two
 * responsibilities described at the top of this file:
 *
 *   CloudWatch Alarm State Change    -> verify (a composite alarm fired)
 *   Tag Change on Resource           -> reconcile (thresholds may have changed)
 *   EC2 Instance State-change        -> reconcile, or tear down on terminate
 *   Scheduled Event / reconcile-all  -> sweep (repair drift)
 */
export async function handler(event: unknown): Promise<unknown> {
  const input = unwrapEvent(event);
  const detailType = input['detail-type'];
  const detail = (input['detail'] ?? {}) as Record<string, unknown>;

  console.log(`Processing event detail-type="${String(detailType)}"`);

  // A composite idle alarm changed state. We only care about transitions into
  // ALARM; returning to OK just means the instance got busy again.
  if (detailType === 'CloudWatch Alarm State Change') {
    const alarmName = String(detail['alarmName'] ?? '');
    const stateValue = String(
      (detail['state'] as Record<string, unknown> | undefined)?.['value'] ?? '',
    );
    if (stateValue !== 'ALARM') {
      console.log(`Ignoring ${alarmName} transition to ${stateValue}`);
      return {execute: false, action: 'stop', reason: `State is ${stateValue}`};
    }
    return verifyIdleStop(alarmName);
  }

  // A tag changed. This is the main path for arming, re-arming after a
  // threshold edit, and disarming when the tag is removed.
  if (detailType === 'Tag Change on Resource') {
    return reconcileByIds(instanceIdsFromArns(input['resources']));
  }

  // An instance changed state. Terminated instances lose their alarms;
  // everything else is reconciled so a newly launched tagged instance gets
  // armed without waiting for the sweep.
  if (detailType === 'EC2 Instance State-change Notification') {
    const instanceId = String(detail['instance-id'] ?? '');
    const state = String(detail['state'] ?? '');
    if (instanceId === '') {
      console.log('EC2 state change event missing instance-id');
      return {reconciled: []};
    }
    if (state === 'terminated' || state === 'shutting-down') {
      await deleteInstanceAlarms(instanceId);
      return {
        reconciled: [
          {
            instanceId,
            outcome: 'deleted',
            reason: `Instance is ${state}`,
            signalKeys: [],
          },
        ],
      };
    }
    return reconcileByIds([instanceId]);
  }

  // Periodic drift repair, from EventBridge Scheduler or a manual invoke.
  if (detailType === 'Scheduled Event' || input['action'] === 'reconcile-all') {
    return {reconciled: await sweep()};
  }

  throw new Error(`Unsupported event detail-type: ${String(detailType)}`);
}
