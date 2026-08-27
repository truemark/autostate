import {NodejsFunction} from 'aws-cdk-lib/aws-lambda-nodejs';
import {Construct} from 'constructs';
import {Architecture, Runtime} from 'aws-cdk-lib/aws-lambda';
import {Duration} from 'aws-cdk-lib';
import {RetentionDays} from 'aws-cdk-lib/aws-logs';
import * as path from 'path';
import {PolicyStatement} from 'aws-cdk-lib/aws-iam';

interface IdleFunctionProps {
  readonly tagPrefix: string;
}

export class IdleFunction extends NodejsFunction {
  constructor(scope: Construct, id: string, props: IdleFunctionProps) {
    super(scope, id, {
      runtime: Runtime.NODEJS_20_X,
      architecture: Architecture.ARM_64,
      memorySize: 512,
      // Longer than SchedulerFunction because of the reconcile sweep, which
      // walks every tagged instance in the account sequentially and makes
      // roughly half a dozen API calls per instance. The verify path returns in
      // well under a second; this ceiling exists purely for the sweep.
      timeout: Duration.minutes(15),
      logRetention: RetentionDays.ONE_MONTH,
      entry: path.join(__dirname, '..', '..', 'handlers', 'src', 'idle.mts'),
      handler: 'handler',
      environment: {
        TAG_PREFIX: props.tagPrefix,
      },
    });

    this.addToRolePolicy(
      new PolicyStatement({
        actions: [
          // Discovery: find tagged instances, and re-describe one instance at
          // verify time to evaluate the guards.
          'ec2:DescribeInstances',

          // Reconcile writes the child metric alarms and the composite that
          // ANDs them together.
          'cloudwatch:PutMetricAlarm',
          'cloudwatch:PutCompositeAlarm',

          // Both Put calls above pass Tags, and CloudWatch requires
          // TagResource separately for that. Without it the whole reconcile
          // fails with AccessDenied rather than merely skipping the tags.
          'cloudwatch:TagResource',

          // Teardown when an instance opts out or is terminated, plus the
          // stale-child cleanup after a threshold change.
          'cloudwatch:DeleteAlarms',

          // Enumerating existing managed alarms by name prefix, used for stale
          // child detection and for orphan cleanup during the sweep.
          'cloudwatch:DescribeAlarms',

          // Calibrating the connection threshold when the connections-max
          // field is "auto" - reads the observed floor of tcp_established.
          'cloudwatch:GetMetricStatistics',
        ],
        // CloudWatch's list/describe actions do not support resource-level
        // permissions, so this statement has to be account-wide. The alarm
        // mutations could be scoped to arn:...:alarm:autostate-* if you want to
        // tighten it, at the cost of coupling IAM to the alarm name prefixes
        // that idle.mts owns.
        resources: ['*'],
      }),
    );

    // Deliberately no states:StartExecution. Unlike scheduler.mts, this handler
    // never starts an execution - it returns a decision and the state machine
    // acts on it. Nor any ec2:StopInstances: the stop is performed by the
    // StopEc2Instance task in autostate-construct.ts, which carries its own
    // permission.
  }
}
