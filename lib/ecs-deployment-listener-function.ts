import {NodejsFunction} from "aws-cdk-lib/aws-lambda-nodejs"
import {Construct} from "constructs"
import {Architecture, Runtime} from "aws-cdk-lib/aws-lambda"
import {Duration} from "aws-cdk-lib"
import {RetentionDays} from "aws-cdk-lib/aws-logs"
import * as path from "path";
import {PolicyStatement} from "aws-cdk-lib/aws-iam"
import {LambdaFunction} from 'aws-cdk-lib/aws-events-targets';
import {Rule} from 'aws-cdk-lib/aws-events';

interface DeploymentListenerFunctionProps {
  readonly tagPrefix: string;
}

export class EcsDeploymentListenerFunction extends NodejsFunction {
  constructor(scope: Construct, id: string, props: DeploymentListenerFunctionProps) {
    super(scope, id, {
      runtime: Runtime.NODEJS_18_X,
      architecture: Architecture.ARM_64,
      memorySize: 512,
      timeout: Duration.seconds(120),
      logRetention: RetentionDays.ONE_MONTH,
      entry: path.join(__dirname, "..", "handlers", "src", "ecs-deployment.ts"),
      handler: "handler",
      environment: {
        TAG_PREFIX: props.tagPrefix
      }
    });

    this.addToRolePolicy(new PolicyStatement({
      actions: ['ecs:ListTagsForResource', 'ecs:TagResource', 'ecs:UntagResource'],
      resources: ["*"]
    }));

    const rule = new Rule(this.stack, 'EcsDeploymentSuccessRule', {
    eventPattern: {
      source: ['aws.ecs'],
        detailType: ['ECS Service Action'],
        detail: {
        eventName: ['SERVICE_STEADY_STATE'],
          desiredStatus: ['RUNNING']
      }
    }
  });

    rule.addTarget(new LambdaFunction(this));
  }
}
