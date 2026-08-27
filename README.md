# Auto State

An AWS CDK project that automatically starts, stops, reboots and terminates resources through tags.

## Supported Resource Types
 * EC2 Instances
 * RDS Instances
 * RDS Clusters
 * ECS Services
 * SageMaker Notebook Instances

## Supported Tags

| Tag                                 | Description                                                                                                        |
|-------------------------------------|--------------------------------------------------------------------------------------------------------------------|
| autostate:timezone                  | The timezone to use when interpreting schedules. Defaults to UTC. Example: America/Denver                          |
| autostate:start-schedule            | The schedule as a cron expression to start the resource. Example: 0 8 * * 1-5                                      |
| autostate:stop-schedule             | The schedule as a cron expression to stop the resource. Example: 0 18 * * 1-5                                      |
| autostate:reboot-schedule           | The schedule as a cron expression to reboot the instance. Example: 0 12 * * 1-5                                    |
| autostate:max-runtime               | The number of minutes the resource may run before being stopped.                                                   |
| autostate:max-lifetime              | The number of minutes the resource may exist before being terminated.                                              |
| autostate:skip-final-snapshot       | Applies to RDS. If set to true, the resource will be terminated without taking a final snapshot. Default is false. |
| autostate:final-snapshot-identifier | Applies to RDS. Used if skip-final-snapshot is set to false. Default "autostatefinal"                              |
| autostate:desired-count             | Applies to ECS. The number of tasks to run for the service when starting. Default 1.                               |
| autostate:idle-detection            | Applies to EC2. Enables idle detection. One of enabled, notify-only or disabled. See Idle Detection.               |
| autostate:idle-threshold            | Applies to EC2. Idle thresholds as duration/grace/cpu-max/network-max/connections-max. See Idle Detection.         |
| autostate:hold-until                | Applies to EC2. Pins the instance running until this ISO 8601 timestamp, overriding idle detection.                |


### Con Expressions
```
 *    *    *    *    *
 ┬    ┬    ┬    ┬    ┬
 │    │    │    │    |
 │    │    │    │    └ day of week (0 - 7, 1L - 7L) (0 or 7 is Sun)
 │    │    │    └───── month (1 - 12)
 │    │    └────────── day of month (1 - 31, L)
 │    └─────────────── hour (0 - 23)
 └──────────────────── minute (0 - 59)
```

### Cron Examples

* `0 8 * * 1-5` - 8am on weekdays
* `0 18 * * 0,6` - 6pm on weekends
* `0 12 * * *` - 12pm every day

### Tag Examples

Start an instance every 15 minutes and shut it down 5 minutes after.
```json
{
  "autostate:start-schedule": "0,15,30,45 * * * *", 
  "autostate:stop-schedule": "5,20,35,50 * * * *"
}
```

Start an instance every 30 minutes and shut it down 10 minutes after it starts on weekdays.
```json
{
  "autostate:start-schedule": "0,30 * * * 1-5", 
  "autostate:max-runtime": "10"
}
```


## Idle Detection

Applies to EC2 instances only.

Schedules only capture predictable waste. Idle detection stops an instance when its
metrics show nothing has been happening for a sustained period, regardless of the clock.
It is configured with at most two tags, and one tag is enough if the defaults suit you.

Idle detection never starts an instance. Pair it with `autostate:start-schedule` if you
want the instance brought back automatically.

### Idle Tags

| Tag                      | Description                                                                                  |
|--------------------------|----------------------------------------------------------------------------------------------|
| autostate:idle-detection | `enabled` to stop idle instances, `notify-only` to observe without stopping, `disabled` (or absent) to turn off. |
| autostate:idle-threshold | Positional thresholds separated by `/`. Every field is optional. See below.                   |
| autostate:hold-until     | ISO 8601 timestamp. While in the future the instance is never stopped.                        |

### Idle Threshold Fields

`autostate:idle-threshold` is `duration/grace/cpu-max/network-max/connections-max`

| # | Field           | Default | Description                                                                    |
|---|-----------------|---------|--------------------------------------------------------------------------------|
| 1 | duration        | 60      | Minutes every signal must stay below its threshold. Values below 30 are raised to 30. |
| 2 | grace           | 30      | Minutes after an instance starts before it becomes eligible to be stopped.      |
| 3 | cpu-max         | 3       | Percent CPU utilization.                                                        |
| 4 | network-max     | 1MB     | Bytes per period. Accepts a `B`, `KB`, `MB`, `GB` or `TB` suffix, or raw bytes. |
| 5 | connections-max | auto    | Established TCP connections. `auto` measures the instance's own quiet floor.     |

Any field may be left blank to take its default, and trailing fields may be omitted
entirely. A field may also be set to `off` to disable that signal completely.

### Idle Signals

Each configured field becomes one or more CloudWatch alarms.

| Field           | Metric                    | Namespace | Requires CloudWatch Agent |
|-----------------|---------------------------|-----------|---------------------------|
| cpu-max         | CPUUtilization            | AWS/EC2   | No                        |
| network-max     | NetworkIn and NetworkOut  | AWS/EC2   | No                        |
| connections-max | netstat_tcp_established   | CWAgent   | Yes                       |

`connections-max` is the strongest available signal, because an instance with no
established connections is almost certainly unused. Its floor is not zero: the SSM
agent and the CloudWatch agent each hold a persistent connection, so the quiet baseline
varies by AMI. This is why the default is `auto`, which measures the observed floor
rather than guessing.

### Idle Tag Examples

Use every default. A 60 minute window, 30 minute grace, CPU below 3%, network below 1MB,
and an automatically measured connection floor.
```json
{
  "autostate:idle-detection": "enabled"
}
```

Override the window and CPU, and let network take its default.
```json
{
  "autostate:idle-detection": "enabled",
  "autostate:idle-threshold": "90/30/5//auto"
}
```

Only the window matters, everything else defaults.
```json
{
  "autostate:idle-detection": "enabled",
  "autostate:idle-threshold": "45"
}
```

Watch and report without ever stopping the instance. Use this first while tuning thresholds.
```json
{
  "autostate:idle-detection": "notify-only"
}
```

Pin an instance so it is never stopped before a deadline, whatever the metrics say.
```json
{
  "autostate:hold-until": "2026-09-01T17:00:00Z"
}
```

### How Idle Detection Works

One CloudWatch alarm is created per signal, phrased as "this signal is low", so the alarm
entering ALARM means that signal looks idle. A composite alarm then combines all of them
with AND, so it only fires when every configured signal has looked idle for the entire
window. When the composite fires, AutoState re-checks the instance and decides whether the
stop is safe.

Missing metric data never counts as idle. If the CloudWatch agent stops reporting, its
alarms leave ALARM and the composite cannot fire, so broken monitoring prevents stops
rather than causing them.

An instance is not stopped, even when the composite fires, if any of the following are
true. The reason is written to the AutoState log in every case.

 * `autostate:hold-until` is set to a future time
 * The instance is a member of an Auto Scaling group
 * The instance is a Spot instance
 * The instance's root device is not EBS
 * The instance started less than `duration` plus `grace` minutes ago
 * The instance is no longer running

### Idle Detection Safeguards

Idle detection refuses to stop instances on ambiguous evidence and falls back to
`notify-only`, logging why, when either of these applies.

 * No connection signal is configured. CPU and network alone cannot tell "nobody is here"
   apart from "somebody is here and reading logs", so `connections-max` set to `off`, or a
   `connections-max` of `auto` that cannot be measured yet, drops the instance to
   `notify-only`.
 * A configured threshold cannot be parsed. Signals are never silently dropped, because
   removing one from the composite would leave fewer conditions to satisfy and make a stop
   more likely rather than less.

### Idle Detection Requirements

 * The CloudWatch agent must be installed with the `netstat` plugin for
   `connections-max`. Configure the agent with `aggregation_dimensions: [["InstanceId"]]`
   so its metrics can be found by instance id alone. If the agent appends extra dimensions
   such as `ImageId` or `InstanceType`, the alarm will find no data and the instance will
   never be stopped.

 * The agent publishes netstat measurements with the plugin name as a prefix, so the
   `tcp_established` measurement appears in CloudWatch as `netstat_tcp_established`. The
   agent config uses the unprefixed name; only the published metric is prefixed. A minimal
   agent config for idle detection looks like this.
   ```json
   {
     "metrics": {
       "namespace": "CWAgent",
       "metrics_collected": {
         "netstat": {
           "measurement": ["tcp_established"],
           "metrics_collection_interval": 60
         }
       },
       "aggregation_dimensions": [["InstanceId"]]
     }
   }
   ```
 * Detailed monitoring is recommended. Without it, native EC2 metrics are published as
   5 minute averages, so a short burst of real work can be averaged away.

## Caveats

 * RDS doesn't allow asterisks or commas in tag values so use hyphens and colons instead when defining cron expressions
    Start an RDS cluster every 30 minutes and shut it down 15 minutes after it starts on weekdays.
    ```json
    {
      "autostate:start-schedule": "0:30 - - - 1-5", 
      "autostate:max-runtime": "10"
    }
    ```

 * The terminate-schedule and reboot-schedule tags are ignored for ECS services.

 * RDS doesn't allow termination of RDS clusters when they are stopped

 * Idle detection applies to EC2 instances only

 * Idle detection never starts an instance. Combine it with `autostate:start-schedule`, or
   start the instance manually

 * Idle detection creates roughly five CloudWatch alarms per instance, so budget about
   $1 per instance per month. The default account limit is 5,000 alarms per region

 * An instance's public IPv4 address changes when it is stopped and started unless an
   Elastic IP is attached

 * Auto Scaling group members are never stopped by idle detection, because the group would
   simply replace them

## References

This project is also published as a AWS CDK Construct for use in your own stacks.
See https://github.com/truemark/cdk-autostate
