import {Construct} from "constructs"
import {Duration, RemovalPolicy} from "aws-cdk-lib"
import {IEventBus, Rule} from "aws-cdk-lib/aws-events"
import {Queue, QueueEncryption} from "aws-cdk-lib/aws-sqs"
import {SchedulerFunction} from "./scheduler-function"
import {
  Choice,
  Condition, Fail,
  JsonPath,
  Pass,
  StateMachine,
  StateMachineType,
  Wait,
  WaitTime,
  Map as SfnMap
} from "aws-cdk-lib/aws-stepfunctions"
import {CallAwsService, LambdaInvoke} from "aws-cdk-lib/aws-stepfunctions-tasks"
import {SfnStateMachine} from "aws-cdk-lib/aws-events-targets"

export interface AutoStateProps {
  readonly tagPrefix?: string;
  readonly eventBus?: IEventBus;
}
export class AutoState extends Construct {
  constructor(scope: Construct, id: string, props: AutoStateProps) {
    super(scope, id);

    const tagPrefix = props.tagPrefix ?? "autostate:";

    const schedulerFunction = new SchedulerFunction(this, "SchedulerFunction", {tagPrefix});

    const addExecutionContext = new Pass(this, "AddExecutionContext", {
      parameters: {
        "Execution.$": "$$.Execution",
        "State.$": "$$.State",
        "StateMachine.$": "$$.StateMachine",
      }
    });

    const wait = new Wait(this, "WaitForAction", {
      time: WaitTime.timestampPath(JsonPath.stringAt("$.Execution.Input.when"))});

    const ec2Stop = new CallAwsService(this, "StopEc2Instance", {
      service: "ec2",
      action: "stopInstances",
      parameters: {
        InstanceIds: JsonPath.array(JsonPath.stringAt("$.resource.id"))
      },
      iamAction: "ec2:StopInstances",
      iamResources: ["*"],
      resultPath: "$.result"
    });

    const ec2Start = new CallAwsService(this, "StartEc2Instance", {
      service: "ec2",
      action: "startInstances",
      parameters: {
        InstanceIds: JsonPath.array(JsonPath.stringAt("$.resource.id"))
      },
      iamAction: "ec2:StartInstances",
      iamResources: ["*"],
      resultPath: "$.result"
    });

    const ec2Reboot = new CallAwsService(this, "RebootEc2Instance", {
      service: "ec2",
      action: "rebootInstances",
      parameters: {
        InstanceIds: JsonPath.array(JsonPath.stringAt("$.resource.id"))
      },
      iamAction: "ec2:RebootInstances",
      iamResources: ["*"],
      resultPath: "$.result"
    });

    const ec2Terminate = new CallAwsService(this, "TerminateEc2Instance", {
      service: "ec2",
      action: "terminateInstances",
      parameters: {
        InstanceIds: JsonPath.array(JsonPath.stringAt("$.resource.id"))
      },
      iamAction: "ec2:TerminateInstances",
      iamResources: ["*"],
      resultPath: "$.result"
    });

    const stopRdsInstance = new CallAwsService(this, "StopRdsInstance", {
      service: "rds",
      action: "stopDBInstance",
      parameters: {
        DbInstanceIdentifier: JsonPath.stringAt("$.resource.id")
      },
      iamAction: "rds:StopDBInstance",
      iamResources: ["*"],
      resultPath: "$.result"
    });

    const startRdsInstance = new CallAwsService(this, "StartRdsInstance", {
      service: "rds",
      action: "startDBInstance",
      parameters: {
        DbInstanceIdentifier: JsonPath.stringAt("$.resource.id")
      },
      iamAction: "rds:StartDBInstance",
      iamResources: ["*"],
      resultPath: "$.result"
    });

    const deletedRdsInstance = new CallAwsService(this, "DeleteRdsInstance", {
      service: "rds",
      action: "deleteDBInstance",
      parameters: {
        DbInstanceIdentifier: JsonPath.stringAt("$.resource.id"),
        SkipFinalSnapshot: JsonPath.stringAt("$.resource.tags.skipFinalSnapshot"),
        FinalDBSnapshotIdentifier: JsonPath.stringAt("$.resource.tags.finalSnapshotIdentifier")
      },
      iamAction: "rds:DeleteDBInstance",
      iamResources: ["*"],
      resultPath: "$.result"
    });

    const rebootDbInstance = new CallAwsService(this, "RebootRdsInstance", {
      service: "rds",
      action: "rebootDBInstance",
      parameters: {
        DbInstanceIdentifier: JsonPath.stringAt("$.resource.id")
      },
      iamAction: "rds:RebootDBInstance",
      iamResources: ["*"],
      resultPath: "$.result"
    });

    const stopRdsCluster = new CallAwsService(this, "StopRdsCluster", {
      service: "rds",
      action: "stopDBCluster",
      parameters: {
        DbClusterIdentifier: JsonPath.stringAt("$.resource.id")
      },
      iamAction: "rds:StopDBCluster",
      iamResources: ["*"],
      resultPath: "$.result"
    });

    const startRdsCluster = new CallAwsService(this, "StartRdsCluster", {
      service: "rds",
      action: "startDBCluster",
      parameters: {
        DbClusterIdentifier: JsonPath.stringAt("$.resource.id")
      },
      iamAction: "rds:StartDBCluster",
      iamResources: ["*"],
      resultPath: "$.result"
    });

    const deleteRdsCluster = new CallAwsService(this, "DeleteRdsCluster", {
      service: "rds",
      action: "deleteDBCluster",
      parameters: {
        DbClusterIdentifier: JsonPath.stringAt("$.resource.id"),
        SkipFinalSnapshot: JsonPath.stringAt("$.resource.tags.skipFinalSnapshot"),
        FinalDBSnapshotIdentifier: JsonPath.stringAt("$.resource.tags.finalSnapshotIdentifier")
      },
      iamAction: "rds:DeleteDBCluster",
      iamResources: ["*"],
      resultPath: "$.result"
    });

    const deleteRdsClusterInstance = new CallAwsService(this, "DeleteRdsClusterInstance", {
      service: "rds",
      action: "deleteDBInstance",
      parameters: {
        DbInstanceIdentifier: JsonPath.stringAt("$.id"),
        SkipFinalSnapshot: true,
      },
      iamAction: "rds:DeleteDBInstance",
      iamResources: ["*"],
      resultPath: "$.result"
    });

    const rebootDbCluster = new CallAwsService(this, "RebootRdsCluster", {
      service: "rds",
      action: "rebootDBCluster",
      parameters: {
        DbClusterIdentifier: JsonPath.stringAt("$.resource.id")
      },
      iamAction: "rds:RebootDBCluster",
      iamResources: ["*"],
      resultPath: "$.result"
    });

    const stopEcsService = new CallAwsService(this, "StopEcsService", {
      service: "ecs",
      action: "updateService",
      parameters: {
        Cluster: JsonPath.stringAt("$.resource.cluster"),
        Service: JsonPath.stringAt("$.resource.serviceName"),
        DesiredCount: 0
      },
      iamAction: "ecs:UpdateService",
      iamResources: ["*"],
      resultPath: "$.result"
    });

    const startEcsService = new CallAwsService(this, "StartEcsService", {
      service: "ecs",
      action: "updateService",
      parameters: {
        Cluster: JsonPath.stringAt("$.resource.cluster"),
        Service: JsonPath.stringAt("$.resource.serviceName"),
        DesiredCount: JsonPath.stringAt("$.resource.tags.desiredCount")
      },
      iamAction: "ecs:UpdateService",
      iamResources: ["*"],
      resultPath: "$.result"
    });

    const deleteRdsClusterInstances = new SfnMap(this, "DeleteRdsInstances", {
      itemsPath: "$.resource.instanceIds",
      resultPath: "$.result"
    }).iterator(deleteRdsClusterInstance).next(deleteRdsCluster);

    const doNothing = new Pass(this, "DoNothing");

    const routeAction = new Choice(this, "ActionRouter")
      .when(Condition.isNotPresent("$.execute"), doNothing)
      .when(Condition.and(
        Condition.booleanEquals("$.execute", true),
        Condition.stringEquals("$.resource.type", "ec2-instance"),
        Condition.stringEquals("$.action", "stop")), ec2Stop)
      .when(Condition.and(
        Condition.booleanEquals("$.execute", true),
        Condition.stringEquals("$.resource.type", "ec2-instance"),
        Condition.stringEquals("$.action", "start")), ec2Start)
      .when(Condition.and(
        Condition.booleanEquals("$.execute", true),
        Condition.stringEquals("$.resource.type", "ec2-instance"),
        Condition.stringEquals("$.action", "reboot")), ec2Reboot)
      .when(Condition.and(
        Condition.booleanEquals("$.execute", true),
        Condition.stringEquals("$.resource.type", "ec2-instance"),
        Condition.stringEquals("$.action", "terminate")), ec2Terminate)

      .when(Condition.and(
        Condition.booleanEquals("$.execute", true),
        Condition.stringEquals("$.resource.type", "rds-instance"),
        Condition.stringEquals("$.action", "stop")), stopRdsInstance)
      .when(Condition.and(
        Condition.booleanEquals("$.execute", true),
        Condition.stringEquals("$.resource.type", "rds-instance"),
        Condition.stringEquals("$.action", "start")), startRdsInstance)
      .when(Condition.and(
        Condition.booleanEquals("$.execute", true),
        Condition.stringEquals("$.resource.type", "rds-instance"),
        Condition.stringEquals("$.action", "reboot")), rebootDbInstance)
      .when(Condition.and(
        Condition.booleanEquals("$.execute", true),
        Condition.stringEquals("$.resource.type", "rds-instance"),
        Condition.stringEquals("$.action", "terminate")), deletedRdsInstance)

      .when(Condition.and(
        Condition.booleanEquals("$.execute", true),
        Condition.stringEquals("$.resource.type", "rds-cluster"),
        Condition.stringEquals("$.action", "stop")), stopRdsCluster)
      .when(Condition.and(
        Condition.booleanEquals("$.execute", true),
        Condition.stringEquals("$.resource.type", "rds-cluster"),
        Condition.stringEquals("$.action", "start")), startRdsCluster)
      .when(Condition.and(
        Condition.booleanEquals("$.execute", true),
        Condition.stringEquals("$.resource.type", "rds-cluster"),
        Condition.stringEquals("$.action", "reboot")), rebootDbCluster)
      .when(Condition.and(
        Condition.booleanEquals("$.execute", true),
        Condition.stringEquals("$.resource.type", "rds-cluster"),
        Condition.stringEquals("$.action", "terminate")), deleteRdsClusterInstances)

      .when(Condition.and(
        Condition.booleanEquals("$.execute", true),
        Condition.stringEquals("$.resource.type", "ecs-service"),
        Condition.stringEquals("$.action", "stop")), stopEcsService)
      .when(Condition.and(
        Condition.booleanEquals("$.execute", true),
        Condition.stringEquals("$.resource.type", "ecs-service"),
        Condition.stringEquals("$.action", "start")), startEcsService)

      .otherwise(doNothing);

    const invokeScheduler = new LambdaInvoke(this, "Scheduler", {
      lambdaFunction: schedulerFunction,
      outputPath: "$.Payload",
    });

    const eventProcessor = new LambdaInvoke(this, "EventProcessor", {
      lambdaFunction: schedulerFunction,
    });

    const eventRouter = new Choice(this, "EventRouter");
    eventRouter.when(Condition.isPresent("$.Execution.Input.when"), wait.next(invokeScheduler).next(routeAction));
    eventRouter.when(Condition.stringEquals("$.Execution.Input.detail-type", "Tag Change on Resource"), eventProcessor);
    eventRouter.when(Condition.stringEquals("$.Execution.Input.detail-type", "EC2 Instance State-change Notification"), eventProcessor);
    eventRouter.when(Condition.stringEquals("$.Execution.Input.detail-type", "RDS DB Instance Event"), eventProcessor);
    eventRouter.when(Condition.stringEquals("$.Execution.Input.detail-type", "RDS DB Cluster Event"), eventProcessor);
    eventRouter.when(Condition.and(
      Condition.stringEquals("$.Execution.Input.detail-type", "AWS API Call via CloudTrail"),
      Condition.stringEquals("$.Execution.Input.source", "aws.ecs"),
    ), eventProcessor);
    eventRouter.otherwise(new Fail(this, "UnknownEvent", {
      cause: "Unknown event type",
    }));

    //  This is where the state machine will write logs.
    const logGroup = new Logs.LogGroup(this, "/autostate-execution-logs/", {});

    const stateMachine = new StateMachine(this, "Default", {
      definition: addExecutionContext.next(eventRouter),
      stateMachineType: StateMachineType.STANDARD,
      removalPolicy: RemovalPolicy.DESTROY,
      logs: {
        destination: logGroup,
        level: LogLevel.ALL,
      },
    });

    // Grant the state machine role the ability to create and deliver to a log stream.
    stateMachine.addToRolePolicy(
      new Iam.PolicyStatement({
        actions: [
          "logs:CreateLogDelivery",
          "logs:CreateLogStream",
          "logs:GetLogDelivery",
          "logs:UpdateLogDelivery",
          "logs:DeleteLogDelivery",
          "logs:ListLogDeliveries",
          "logs:PutLogEvents",
          "logs:PutResourcePolicy",
          "logs:DescribeResourcePolicies",
          "logs:DescribeLogGroups"
        ],
        resources: ['*'],
      })
    );

    // const stateMachine = new StateMachine(this, "Default", {
    //   definition: addExecutionContext.next(eventRouter),
    //   stateMachineType: StateMachineType.STANDARD,
    //   removalPolicy: RemovalPolicy.DESTROY,
    // });

    // TODO Add alarm on dead letter queue
    const deadLetterQueue = new Queue(this, "DeadLetterQueue", {
      encryption: QueueEncryption.SQS_MANAGED,
      removalPolicy: RemovalPolicy.DESTROY,
      retentionPeriod: Duration.days(14)
    });

    const tagRule = new Rule(this, "TagRule", {
      eventPattern: {
        source: ["aws.tag"],
        detailType: ["Tag Change on Resource"],
        detail: {
          service: ["ec2", "rds", "ecs"],
          "resource-type": ["service", "cluster", "instance", "db"],
          "changed-tag-keys": [
            "autostate:stop-schedule",
            "autostate:start-schedule",
            "autostate:reboot-schedule",
            "autostate:terminate-schedule",
            "autostate:max-runtime",
            "autostate:max-lifetime",
            "autostate:timezone",
          ],
        }
      },
      description: "Routes tag events AutoState Step Function"
    });
    tagRule.addTarget(new SfnStateMachine(stateMachine, {deadLetterQueue}));

    const ec2StartRule = new Rule(this, "Ec2StartRule", {
      eventPattern: {
        source: ["aws.ec2"],
        detailType: ["EC2 Instance State-change Notification"],
        detail: {
          state: ["running"],
        }
      },
      description: "Routes EC2 start events to AutoState Step Function",
      eventBus: props.eventBus
    });
    ec2StartRule.addTarget(new SfnStateMachine(stateMachine, {deadLetterQueue}));

    const rdsStartRule = new Rule(this, "RdsStartRule", {
      eventPattern: {
        source: ["aws.rds"],
        detailType: ["RDS DB Instance Event", "RDS DB Cluster Event"],
        detail: {
          SourceType: ["DB_INSTANCE", "CLUSTER"],
          Message: ["DB instance started", "DB cluster started"]
        }
      },
      description: "Routes RDS start events to AutoState Step Function",
      eventBus: props.eventBus
    });
    rdsStartRule.addTarget(new SfnStateMachine(stateMachine, {deadLetterQueue}));

    const ecsStartRule = new Rule(this, "EcsStartRule", {
      eventPattern: {
        source: ["aws.ecs"],
        detailType: ["AWS API Call via CloudTrail"],
        detail: {
          "eventSource": ["ecs.amazonaws.com"],
          "eventName": ["UpdateService"],
          "requestParameters": {
            "desiredCount": [ { "numeric": [ ">", 0 ] } ]
          }
        }
      }
    });
    ecsStartRule.addTarget(new SfnStateMachine(stateMachine, {deadLetterQueue}));
  }
}
