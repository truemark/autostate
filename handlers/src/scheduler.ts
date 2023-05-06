import * as arnparser from "@aws-sdk/util-arn-parser"
import * as cron from "cron-parser";
import {CronExpression} from "cron-parser/types"
import {DescribeInstancesCommand, EC2Client, Instance} from '@aws-sdk/client-ec2'
import {SFNClient, StartExecutionCommand} from "@aws-sdk/client-sfn"
import {DateTime} from "luxon"
import {
  DescribeDBClustersCommand,
  DescribeDBInstancesCommand,
  DescribeEventsCommand,
  RDSClient, SourceType,
  Tag as RdsTag
} from "@aws-sdk/client-rds"
import {
  DescribeServicesCommand,
  ECSClient,
  ListTagsForResourceCommand,
  Service,
  Tag as EcsTag
} from "@aws-sdk/client-ecs"

const ec2Client = new EC2Client({});
const rdsClient = new RDSClient({});
const sfnClient = new SFNClient({});
const ecsClient = new ECSClient({});

type ResourceType = "ec2-instance" | "rds-instance" | "rds-cluster" | "ecs-service";
type Action = "start" | "stop" | "reboot" | "terminate";
type State = "stopped" | "running" | "terminated" | "other";

interface AutoStateTags {
  readonly timezone?: string;
  readonly startSchedule?: string;
  readonly stopSchedule?: string;
  readonly rebootSchedule?: string;
  readonly maxRuntime?: string;
  readonly maxLifetime?: string;
  readonly desiredCount?: number;
  readonly finalSnapshotIdentifier?: string;
  readonly skipFinalSnapshot?: string;
}

export function cyrb53(str: string, seed: number = 0): number {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for(let i = 0, ch; i < str.length; i++) {
    ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1  = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2  = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);

  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

function hashTags(tags: AutoStateTags): number {
  return cyrb53(`${tags.timezone ?? ""}|${tags.startSchedule ?? ""}|` +
    `${tags.stopSchedule ?? ""}|${tags.rebootSchedule ?? ""}|` +
    `${tags.maxRuntime ?? ""}|${tags.maxLifetime ?? ""}`);
}

interface AutoStateResource {
  readonly type: ResourceType;
  readonly id: string,
  readonly tags: AutoStateTags,
  readonly startTime: string,
  readonly createTime: string,
  readonly state: State
}

interface AutoStateEcsResource extends AutoStateResource {
  readonly cluster: string,
  readonly serviceName: string,
}

interface AutoStateRdsClusterInstance {
  readonly id: string,
}

interface AutoStateRdsClusterResource extends AutoStateResource {
  readonly instanceIds: AutoStateRdsClusterInstance[]
}

interface AutoStateAction {
  readonly resource: AutoStateResource;
  readonly when: string;
  readonly action: Action;
  readonly execute?: boolean;
  readonly reason?: string;
}

function getActionName(action: AutoStateAction, hashId?: boolean): string {
  const id = hashId ? cyrb53(action.resource.id) : action.resource.id;
  return `${action.resource.type}-${id}-${action.action}-` +
    `${DateTime.fromISO(action.when).toFormat("yyyy-MM-dd-HH-mm")}-${hashTags(action.resource.tags)}`;
}

function optionalNumber(value: string | undefined): number | undefined {
  return value ? Number(value) : undefined;
}

function optionalCron(value: string | undefined, tz: string): CronExpression | undefined {
  return value ? cron.parseExpression(value.replaceAll("-", "*"), {tz}) : undefined;
}

function cronAction(resource: AutoStateResource, action: Action, cronExpression: string): AutoStateAction | undefined {
  const tz = resource.tags.timezone ?? "UTC";
  const cron = optionalCron(cronExpression, tz);
  if (cron && cron.hasNext()) {
    return {
      resource,
      when: cron.next().toISOString(),
      action,
    };
  }
}

function cronActions(resource: AutoStateResource): AutoStateAction[] {
  const actions: AutoStateAction[] = [];
  const start = cronAction(resource, "start", resource.tags.startSchedule);
  if (start) {
    actions.push(start);
  }
  const stop = cronAction(resource, "stop", resource.tags.stopSchedule);
  if (stop) {
    actions.push(stop);
  }
  if (resource.type !== "ecs-service") { // ECS services don't support reboot
    const reboot = cronAction(resource, "reboot", resource.tags.rebootSchedule);
    if (reboot) {
      actions.push(reboot);
    }
  }
  return actions;
}

function nextAction(resource: AutoStateResource, priorAction?: AutoStateAction): AutoStateAction | undefined {
  let selected = undefined;
  const actions = [...cronActions(resource), ...durationActions(resource, priorAction)];
  console.log("Evaluation " + actions.length + "possible actions for resource " + resource.id);
  for (const action of actions) {
    if (selected === undefined || action.when < selected.when) {
      selected = action;
    }
  }
  return selected;
}

function calculateWhen(time: string, minutes: number): Date {
  const when = new Date(time).getTime() + (minutes * 60000);
  return when < Date.now()
    ? new Date(new Date().setMilliseconds(0) + 60000) // clears out milliseconds and adds 1 minute
    : new Date(when);
}

function durationAction(resource: AutoStateResource, action: Action, duration?: string): AutoStateAction | undefined {
  const minutes = optionalNumber(duration);
  if (minutes) {
    const when = calculateWhen(action === "stop" && resource.state === "running" ? resource.startTime : resource.createTime, minutes);
    return {
      resource,
      when: when.toISOString(),
      action
    };
  }
  return undefined;
}

function durationActions(resource: AutoStateResource, priorAction: AutoStateAction): AutoStateAction[] {
  const actions: AutoStateAction[] = [];
  if (resource.state !== "stopped" && (!priorAction || priorAction.action !== "stop")) {
    const maxRuntime = durationAction(resource, "stop", resource.tags.maxRuntime);
    if (maxRuntime) {
      actions.push(maxRuntime);
    }
  }
  if (resource.type !== "ecs-service") { // ECS services don't support termination
    const maxLifetime = durationAction(resource, "terminate", resource.tags.maxLifetime);
    if (maxLifetime) {
      actions.push(maxLifetime);
    }
  }
  return actions;
}

function toCamelCase(str: string): string {
  str = (str.match(/[a-zA-Z0-9]+/g) || []).map(x => `${x.charAt(0).toUpperCase()}${x.slice(1)}`).join("");
  return str.charAt(0).toLowerCase() + str.slice(1);
}

function getEc2CreateTime(instance: Instance): Date {
  let date: Date | undefined = undefined;
  for (const blockDeviceMapping of instance.BlockDeviceMappings ?? []) {
    if (blockDeviceMapping.Ebs.AttachTime) {
      if (date === undefined || blockDeviceMapping.Ebs.AttachTime < date) {
        date = blockDeviceMapping.Ebs.AttachTime;
      }
    }
  }
  return date ? date : instance.LaunchTime;
}

async function describeEc2Instances(instanceIds: string[]): Promise<AutoStateResource[]> {
  const resources: AutoStateResource[] = [];
  const output = await ec2Client.send(new DescribeInstancesCommand({
    InstanceIds: instanceIds
  }));
  for (const reservation of output.Reservations) {
    for (const instance of reservation.Instances) {
      let state: State = "other";
      if (instance.State?.Name === "running") {
        state = "running";
      } else if (instance.State?.Name === "stopped" || instance.State?.Name === "stopping") {
        state = "stopped";
      } else if (instance.State?.Name === "terminated") {
        state = "terminated";
      }
      resources.push({
        type: "ec2-instance",
        id: instance.InstanceId,
        createTime: getEc2CreateTime(instance).toISOString(),
        startTime: instance.LaunchTime.toISOString(),
        state,
        tags: instance.Tags?.reduce((tags, tag) => {
          if (tag.Key === "autostate:stop-schedule"
            || tag.Key === "autostate:start-schedule"
            || tag.Key === "autostate:reboot-schedule"
            || tag.Key === "autostate:max-runtime"
            || tag.Key === "autostate:max-lifetime"
            || tag.Key === "autostate:timezone") {
            tags[toCamelCase(tag.Key.replace("autostate:", ""))] = tag.Value.trim();
          }
          return tags;
        }, {} as AutoStateTags) ?? {}
      });
    }
  }
  return resources;
}

async function getRdsStartTime(sourceType: SourceType, instanceId: string): Promise<Date> {
  const output = await rdsClient.send(new DescribeEventsCommand({
    SourceType: sourceType,
    SourceIdentifier: instanceId,
    EventCategories: ["notification"],
    // See https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_ListEvents.html
    Duration: 20160 // 14 days is all that's available
  }));
  let date = new Date(Date.now() - 1209600000); // 14 days
  for (const event of output.Events) {
    if (event.Message === "DB instance started" || event.Message === "DB cluster started") {
      if (event.Date && event.Date > date) {
        date = event.Date;
      }
    }
  }
  return date;
}

function rdsTags(tags?: RdsTag[]): AutoStateTags {
  if (!tags) {
    return {};
  }
  const autoStateTags = tags.reduce((tags, tag) => {
    if (tag.Key === "autostate:stop-schedule"
      || tag.Key === "autostate.start-schedule"
      || tag.Key === "autostate:reboot-schedule"
      || tag.Key === "autostate:max-runtime"
      || tag.Key === "autostate:max-lifetime"
      || tag.Key === "autostate:timezone"
      || tag.Key === "autostate:skip-final-snapshot"
      || tag.Key === "autostate:final-snapshot-identifier") {
      tags[toCamelCase(tag.Key.replace("autostate:", ""))] = tag.Value.trim();
    }
    return tags;
  }, {} as AutoStateTags) ?? {};
  const skipFinalSnapshot = autoStateTags.skipFinalSnapshot === "true" ? "true" : "false";
  const finalSnapshotIdentifier = skipFinalSnapshot === "true"
    ? ""
    : autoStateTags.finalSnapshotIdentifier ?? "autostatefinal";
  return {
    ...autoStateTags,
    skipFinalSnapshot,
    finalSnapshotIdentifier
  }
}

async function describeRdsInstances(instanceId: string): Promise<AutoStateResource[]> {
  const resources: AutoStateResource[] = [];
  try {
    const output = await rdsClient.send(new DescribeDBInstancesCommand({
      DBInstanceIdentifier: instanceId
    }));
    for (const instance of output.DBInstances) {
      const startTime = await getRdsStartTime(SourceType.db_instance, instanceId).then(date => date.toISOString());
      let state: State = "other";
      if (instance.DBInstanceStatus === "available") {
        state = "running";
      } else if (instance.DBInstanceStatus === "stopped" || instance.DBInstanceStatus === "stopping") {
        state = "stopped";
      }
      resources.push({
        type: "rds-instance",
        id: instanceId,
        createTime: instance.InstanceCreateTime?.toISOString() ?? new Date().toISOString(),
        startTime,
        state,
        tags: rdsTags(instance.TagList)
      });
    }
  } catch (e) {
    if (e.errorType !== "DBInstanceNotFoundFault") {
      return resources;
    } else {
      throw e;
    }
  }
  return resources;
}

async function describeRdsClusters(clusterId: string): Promise<AutoStateRdsClusterResource[]> {
  const resources: AutoStateRdsClusterResource[] = [];
  try {
    const output = await rdsClient.send(new DescribeDBClustersCommand({
      DBClusterIdentifier: clusterId
    }));
    for (const cluster of output.DBClusters) {
      const startTime = await getRdsStartTime(SourceType.db_cluster, clusterId).then(date => date.toISOString());
      const instanceIds: AutoStateRdsClusterInstance[] = cluster.DBClusterMembers?.map(member => {return {id: member.DBInstanceIdentifier }}) ?? [];
      let state: State = "other";
      if (cluster.Status === "available") {
        state = "running";
      } else if (cluster.Status === "stopped" || cluster.Status === "stopping") {
        state = "stopped";
      }
      resources.push({
        type: "rds-cluster",
        id: clusterId,
        createTime: cluster.ClusterCreateTime?.toISOString() ?? new Date().toISOString(),
        startTime: startTime,
        state,
        instanceIds,
        tags: rdsTags(cluster.TagList)
      })
    }
  } catch (e) {
    if (e.errorType !== "DBClusterNotFoundFault") {
      return resources;
    } else {
      throw e;
    }
  }
  return resources;
}

function getEcsServiceStartTime(service: Service): Date {
  let date: Date | undefined = undefined;
  for (const deployment of service.deployments ?? []) {
    if (date === undefined) {
      date = deployment.updatedAt;
    } if (deployment.updatedAt > date) {
      date = deployment.updatedAt;
    }
  }
  return date ? date : new Date();
}

async function listTagsForEcsResource(arn: string): Promise<EcsTag[]> {
  const output = await ecsClient.send(new ListTagsForResourceCommand({
    resourceArn: arn
  }));
  return output.tags;
}

function ecsTags(tags?: EcsTag[]): AutoStateTags {
  if (!tags) {
    return {};
  }
  const autoStateTags = tags?.reduce((tags, tag) => {
    if (tag.key === "autostate:stop-schedule"
      || tag.key === "autostate.start-schedule"
      || tag.key === "autostate:reboot-schedule"
      || tag.key === "autostate:max-runtime"
      || tag.key === "autostate:max-lifetime"
      || tag.key === "autostate:timezone"
      || tag.key === "autostate:desired-count") {
      tags[toCamelCase(tag.key.replace("autostate:", ""))] = tag.value.trim();
    }
    return tags;
  }, {} as AutoStateTags) ?? {};
  return {
    ...autoStateTags,
    desiredCount: autoStateTags.desiredCount ?? 1
  }
}

async function describeEcsService(arn: string): Promise<AutoStateEcsResource[]> {
  const resourceIdParts = arnparser.parse(arn).resource.split("/");
  const resources: AutoStateEcsResource[] = [];
  const cluster = resourceIdParts[1];
  const serviceName = resourceIdParts[2];
  const output = await ecsClient.send(new DescribeServicesCommand({
    cluster: cluster,
    services: [serviceName]
  }));
  for (const service of output.services) {
    const tags = await listTagsForEcsResource(service.serviceArn);
    let state: State = "other";
    if (service.status === "ACTIVE") {
      if (service.desiredCount === 0) {
        state = "stopped";
      } else {
        state = "running";
      }
    } else if (service.status === "INACTIVE") {
      state = "terminated";
    }
    resources.push({
      type: "ecs-service",
      id: service.serviceArn,
      createTime: service.createdAt?.toISOString() ?? new Date().toISOString(),
      startTime: getEcsServiceStartTime(service).toISOString(),
      state,
      tags: ecsTags(tags),
      cluster,
      serviceName
    });
  }
  return resources;
}

async function startExecution(stateMachineArn: string, action?: AutoStateAction, hashId?: boolean): Promise<void> {
  if (action) {
    const input = JSON.stringify(action);
    console.log("Starting execution of state machine", stateMachineArn, "with input", input);
    await sfnClient.send(new StartExecutionCommand({
      stateMachineArn,
      input,
      name: getActionName(action, hashId)
    }));
  }
}

export async function handleAction(stateMachineArn: string, action: AutoStateAction): Promise<any> {
  let resources = [];
  if (action.resource.type === "ec2-instance") {
    resources = await describeEc2Instances([action.resource.id]);
  }
  if (action.resource.type === "rds-instance") {
    resources = await describeRdsInstances(action.resource.id);
  }
  if (action.resource.type === "rds-cluster") {
    resources = await describeRdsClusters(action.resource.id);
  }
  if (action.resource.type === "ecs-service") {
    resources = await describeEcsService(action.resource.id);
  }
  if (resources.length === 0) {
    return {...action, execute: false, reason: "Instance no longer exists"};
  }
  const resource = resources[0];
  if (resource.tags.timezone === action.resource.tags.timezone &&
    resource.tags.startSchedule === action.resource.tags.startSchedule &&
    resource.tags.stopSchedule === action.resource.tags.stopSchedule &&
    resource.tags.rebootSchedule === action.resource.tags.rebootSchedule &&
    resource.tags.maxRuntime === action.resource.tags.maxRuntime &&
    resource.tags.maxLifetime === action.resource.tags.maxLifetime) {
    if (action.action === "start") {
      await startExecution(stateMachineArn, nextAction(resource, action), action.resource.type === "ecs-service");
      return {
        ...action,
        execute: resource.state === "stopped",
        reason: resource.state === "stopped" ? "Checks passed" : "Instance is not stopped",
      };
    }
    if (action.action === "stop" || action.action === "reboot") {
      await startExecution(stateMachineArn, nextAction(resource, action), action.resource.type === "ecs-service");
      return {
        ...action,
        execute: resource.state === "running",
        reason: resource.state === "running" ? "Checks passed" : "Instance is not running",
      };
    }
    if (action.action === "terminate") {
      return {
        ...action,
        execute: resource.state !== "terminated",
        reason: resource.state !== "terminated" ? "Checks passed" : "Instance is already terminated",
      };
    }
  } else {
    if (action.resource.type === "ecs-service") {
      return {
        ...action,
        execute: false,
        reason: "Tags do not match"
      };
    }
  }
}

export async function handleCloudWatchEvent(stateMachineArn: string, event: any): Promise<void> {
  if ((event["detail-type"] === "Tag Change on Resource" && event.detail.service === "ec2")
    || event["detail-type"] === "EC2 Instance State-change Notification") {
    console.log("Processing EC2 related event " + event.id);
    const resources = await describeEc2Instances(event.resources.map(arn => arnparser.parse(arn).resource.replace("instance/", "")));
    for (const resource of resources) {
      console.log("Scheduling EC2 instance " + resource.id);
      const action = nextAction(resource);
      if (action) {
        console.log("Next action is " + action.action + " on resource" + resource.id + " at " + action.when);
        await startExecution(stateMachineArn, action);
      } else {
        console.log("No action scheduled for resource " + resource.id);
      }
    }
  } else if ((event["detail-type"] === "Tag Change on Resource" && event.detail.service === "rds")
    || event["detail-type"] === "RDS DB Instance Event" || event["detail-type"] === "RDS DB Cluster Event") {
    console.log("Processing RDS related event " + event.id);
    for (const resourceArn of event.resources) {
      const resourceId = arnparser.parse(resourceArn).resource;
      console.log("Scheduling RDS resource " + resourceId);
      const resources = resourceId.startsWith("db:")
        ? await describeRdsInstances(resourceId.replace("db:", ""))
        : await describeRdsClusters(resourceId.replace("cluster:", ""));
      for (const resource of resources) {
        const action = nextAction(resource);
        if (action) {
          console.log("Next action is " + action.action + " on resource" + resource.id + " at " + action.when);
          await startExecution(stateMachineArn, action);
        } else {
          console.log("No action scheduled for resource " + resource.id);
        }
      }
    }
  } else if ((event["detail-type"] === "Tag Change on Resource" && event.detail.service === "ecs")
    || event["detail-type"] === "AWS API Call via CloudTrail" && event["source"] === "aws.ecs") {
    console.log("Processing ECS related event " + event.id);
    const resources = event["detail-type"] === "AWS API Call via CloudTrail"
      ? [event.detail.requestParameters.service] : event.resources;
    for (const resourceArn of resources) {
      console.log("Scheduling ECS resource " + resourceArn);
      const resources = await describeEcsService(resourceArn);
      for (const resource of resources) {
        const action = nextAction(resource);
        if (action) {
          console.log("Next action is " + action.action + " on resource" + resource.id + " at " + action.when);
          await startExecution(stateMachineArn, action, true);
        } else {
          console.log("No action scheduled for resource " + resource.id);
        }
      }
    }
  }
}

export async function handler(event: any): Promise<any> {
  console.log("Event", JSON.stringify(event, null, 2));
  const stateMachineArn = event.StateMachine.Id;
  const input = event.Execution.Input;
  if (input.detail) {
    return handleCloudWatchEvent(stateMachineArn, input);
  } else {
    const action = input as AutoStateAction;
    console.log(`Processing ${action.action} action on ${action.resource.type} ${action.resource.id} at ${action.when}`);
    if (action.resource.type === "ec2-instance"
        || action.resource.type === "rds-instance"
        || action.resource.type === "rds-cluster"
        || action.resource.type === "ecs-service") {
      return handleAction(stateMachineArn, action);
    }
  }
}
