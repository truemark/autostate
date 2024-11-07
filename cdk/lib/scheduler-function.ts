import {NodejsFunction} from 'aws-cdk-lib/aws-lambda-nodejs';
import {Construct} from 'constructs';
import {Architecture, Runtime} from 'aws-cdk-lib/aws-lambda';
import {Duration} from 'aws-cdk-lib';
import {RetentionDays} from 'aws-cdk-lib/aws-logs';
import * as path from 'path';
import {PolicyStatement} from 'aws-cdk-lib/aws-iam';

interface SchedulerFunctionProps {
  readonly tagPrefix: string;
}

export class SchedulerFunction extends NodejsFunction {
  constructor(scope: Construct, id: string, props: SchedulerFunctionProps) {
    super(scope, id, {
      runtime: Runtime.NODEJS_20_X,
      architecture: Architecture.ARM_64,
      memorySize: 512,
      timeout: Duration.seconds(300),
      logRetention: RetentionDays.ONE_MONTH,
      entry: path.join(
        __dirname,
        '..',
        '..',
        'handlers',
        'src',
        'scheduler.mts',
      ),
      handler: 'handler',
      environment: {
        TAG_PREFIX: props.tagPrefix,
      },
    });

    this.addToRolePolicy(
      new PolicyStatement({
        actions: [
          'ec2:DescribeInstances',
          'rds:DescribeDBClusters',
          'rds:DescribeDBInstances',
          'rds:DescribeEvents',
          'ecs:DescribeServices',
          'ecs:ListTagsForResource',
          'states:StartExecution',
        ],
        resources: ['*'],
      }),
    );
  }
}
