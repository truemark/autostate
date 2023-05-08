import * as arnparser from "@aws-sdk/util-arn-parser"
import * as cron from "cron-parser";
import {CronExpression} from "cron-parser/types"
import {DescribeInstancesCommand, EC2Client, Instance, Tag} from '@aws-sdk/client-ec2'
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

function hashTagsV1(tags: AutoStateTags): string {
  return "V1" + cyrb53(`${tags.timezone ?? ""}|${tags.startSchedule ?? ""}|` +
    `${tags.stopSchedule ?? ""}|${tags.rebootSchedule ?? ""}|` +
    `${tags.maxRuntime ?? ""}|${tags.maxLifetime ?? ""}`);
}

interface AutoStateResource {
  readonly type: ResourceType;
  readonly id: string,
  readonly tags: AutoStateTags,
  readonly tagsHash: string,
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
  readonly resourceType: ResourceType;
  readonly resourceId: string;
  readonly tagHash: string;
  readonly when: string;
  readonly action: Action;
}

interface AutoStateActionResult extends AutoStateAction {
  readonly execute: boolean;
  readonly reason: string;
  readonly resource?: AutoStateResource;
}

function getActionName(action: AutoStateAction, tags: AutoStateTags, hashId?: boolean): string {
  const id = hashId ? cyrb53(action.resourceId) : action.resourceId;
  return `${action.resourceType}-${id}-${action.action}-` +
    `${DateTime.fromISO(action.when).toFormat("yyyy-MM-dd-HH-mm")}-${hashTagsV1(tags)}`;
}

function optionalNumber(value: string | undefined): number | undefined {
  return value ? Number(value) : undefined;
}

function optionalCron(value: string | undefined, tz: string): CronExpression | undefined {
  if (value) {
    const parts = value.split(/\s+/);
    if (parts.length !== 5) {
      throw new Error(`Invalid cron expression: ${value}. Expecting 5 fields and received ${parts.length}}`);
    }
    if (parts[0].trim() === "*" || parts[0].trim() === "-") {
      throw new Error("Invalid cron expression. The use * or - in the minute field is not allowed.");
    }
    const cleaned = value.trim().replaceAll(" -", " *").replaceAll(":", ",");
    return cron.parseExpression(cleaned, {
      tz,
      currentDate: new Date(Date.now() + 60000), // look 1 minute in the future to be safe
    })
  }
  return undefined;
}

function cronAction(resource: AutoStateResource, action: Action, cronExpression: string): AutoStateAction | undefined {
  const tz = resource.tags.timezone ?? "UTC";
  const expression = optionalCron(cronExpression, tz);
  if (expression && expression.hasNext()) {
    return {
      resourceType: resource.type,
      resourceId: resource.id,
      when: expression.next().toISOString(),
      action,
      tagHash: hashTagsV1(resource.tags),
    };
  }
}

function cronActions(resource: AutoStateResource): AutoStateAction[] {
  const actions: AutoStateAction[] = [];
  if (resource.tags.startSchedule) {
    const start = cronAction(resource, "start", resource.tags.startSchedule);
    if (start) {
      actions.push(start);
    }
  }
  if (resource.tags.stopSchedule) {
    const stop = cronAction(resource, "stop", resource.tags.stopSchedule);
    if (stop) {
      actions.push(stop);
    }
  }
  // ECS services don't support reboot
  if (resource.type !== "ecs-service" && resource.tags.rebootSchedule) {
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
  console.log(`Evaluating ${actions.length} possible future actions for ${resource.type} ${resource.id}`);
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
      resourceType: resource.type,
      resourceId: resource.id,
      when: when.toISOString(),
      action,
      tagHash: hashTagsV1(resource.tags)
    };
  }
  return undefined;
}

function durationActions(resource: AutoStateResource, priorAction: AutoStateAction): AutoStateAction[] {
  const actions: AutoStateAction[] = [];
  if (resource.state !== "stopped" && (!priorAction || priorAction.action !== "stop") && resource.tags.maxRuntime) {
    const maxRuntime = durationAction(resource, "stop", resource.tags.maxRuntime);
    if (maxRuntime) {
      actions.push(maxRuntime);
    }
  }
  // ECS services don't support termination
  if (resource.type !== "ecs-service" && resource.tags.maxLifetime) {
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

function getEc2Tags(tags?: Tag[]): AutoStateTags {
  return tags?.reduce((tags, tag) => {
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
      const tags = getEc2Tags(instance.Tags);
      const tagsHash = hashTagsV1(tags);
      resources.push({
        type: "ec2-instance",
        id: instance.InstanceId,
        createTime: getEc2CreateTime(instance).toISOString(),
        startTime: instance.LaunchTime.toISOString(),
        state,
        tags,
        tagsHash
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
      const tags = rdsTags(instance.TagList);
      const tagsHash = hashTagsV1(tags);
      resources.push({
        type: "rds-instance",
        id: instanceId,
        createTime: instance.InstanceCreateTime?.toISOString() ?? new Date().toISOString(),
        startTime,
        state,
        tags,
        tagsHash
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
      const tags = rdsTags(cluster.TagList);
      const tagsHash = hashTagsV1(tags);
      resources.push({
        type: "rds-cluster",
        id: clusterId,
        createTime: cluster.ClusterCreateTime?.toISOString() ?? new Date().toISOString(),
        startTime: startTime,
        state,
        instanceIds,
        tags,
        tagsHash
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
    const tags = ecsTags(await listTagsForEcsResource(service.serviceArn));
    const tagsHash = hashTagsV1(tags);
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
      tags,
      tagsHash,
      cluster,
      serviceName
    });
  }
  return resources;
}

async function startExecution(stateMachineArn: string, resource: AutoStateResource, action?: AutoStateAction): Promise<void> {
  if (action) {
    const input = JSON.stringify(action);
    console.log(`Scheduling ${action.resourceType} ${action.resourceId} to ${action.action} at ${action.when}`);
    console.log("Execution Input: " + input);
    await sfnClient.send(new StartExecutionCommand({
      stateMachineArn,
      input,
      name: getActionName(action, resource.tags, resource.type === "ecs-service")
    }));
  }
}

export async function processStateAction(stateMachineArn: string, action: AutoStateAction): Promise<AutoStateActionResult | undefined> {
  console.log(`Processing ${action.action} of ${action.resourceType} ${action.resourceId} at ${action.when}`);
  let resources = [];
  if (action.resourceType === "ec2-instance") {
    resources = await describeEc2Instances([action.resourceId]);
  }
  if (action.resourceType === "rds-instance") {
    resources = await describeRdsInstances(action.resourceId);
  }
  if (action.resourceType === "rds-cluster") {
    resources = await describeRdsClusters(action.resourceId);
  }
  if (action.resourceType === "ecs-service") {
    resources = await describeEcsService(action.resourceId);
  }
  if (resources.length === 0) {
    return {...action, execute: false, reason: "Instance no longer exists"};
  }
  const resource = resources[0];
  const tagsHash = hashTagsV1(resource.tags);
  if (tagsHash !== action.tagHash) {
    console.log(`${action.resourceType} ${action.resourceId} tags do not match execution, doing nothing...`);
    return {
      ...action,
      execute: false,
      reason: "Tags do not match execution",
      resource
    };
  }
  if (action.action === "start") {
    await startExecution(stateMachineArn, resource, nextAction(resource, action));
    if (resource.state === "stopped") {
      console.log(`${action.resourceType} ${action.resourceId} is stopped, starting...`);
      return {
        ...action,
        execute: true,
        reason: "Checks passed",
        resource
      };
    } else {
      console.log(`${action.resourceType} ${action.resourceId} is not stopped, doing nothing...`);
      return {
        ...action,
        execute: false,
        reason: "Instance is not stopped",
        resource
      };
    }
  }
  if (action.action === "stop" || action.action === "reboot") {
    await startExecution(stateMachineArn, resource, nextAction(resource, action));
    if (resource.state === "running") {
      console.log(`${action.resourceType} ${action.resourceId} is running, ${action.action === "stop" ? "stopping" : "rebooting"}...`);
      return {
        ...action,
        execute: true,
        reason: "Checks passed",
        resource
      }
    } else {
      console.log(`${action.resourceType} ${action.resourceId} is not running, doing nothing...`);
      return {
        ...action,
        execute: false,
        reason: "Instance is not running",
        resource
      }
    }
  }
  if (action.action === "terminate") {
    if (resource.state !== "terminated") {
      console.log(`${action.resourceType} ${action.resourceId} is not terminated, terminating...`);
      return {
        ...action,
        execute: true,
        reason: "Checks passed",
        resource
      };
    } else {
      console.log(`${action.resourceType} ${action.resourceId} is already terminated, doing nothing...`);
      return {
        ...action,
        execute: false,
        reason: "Instance is already terminated",
        resource
      };
    }
  }
}

export async function handleCloudWatchEvent(stateMachineArn: string, event: any): Promise<void> {
  console.log(`Processing CloudWatch event ${event.id}`);
  let resources: AutoStateResource[] = [];
  if ((event["detail-type"] === "Tag Change on Resource" && event.detail.service === "ec2")
    || event["detail-type"] === "EC2 Instance State-change Notification") {
    resources.push(...await describeEc2Instances(
        event.resources.map(arn => arnparser.parse(arn).resource.replace("instance/", ""))));
  } else if ((event["detail-type"] === "Tag Change on Resource" && event.detail.service === "rds")
      || event["detail-type"] === "RDS DB Instance Event" || event["detail-type"] === "RDS DB Cluster Event") {
    for (const resourceArn of event.resources) {
      const resourceId = arnparser.parse(resourceArn).resource;
      resources.push(...resourceId.startsWith("db:")
          ? await describeRdsInstances(resourceId.replace("db:", ""))
          : await describeRdsClusters(resourceId.replace("cluster:", "")));
    }
  } else if ((event["detail-type"] === "Tag Change on Resource" && event.detail.service === "ecs")
      || event["detail-type"] === "AWS API Call via CloudTrail" && event["source"] === "aws.ecs") {
    resources.push(...event["detail-type"] === "AWS API Call via CloudTrail"
        ? [event.detail.requestParameters.service]
        : event.resources);
  }
  for (const resource of resources) {
    console.log(`Evaluating schedule for ${resource.type} ${resource.id}`);
    const action = nextAction(resource);
    if (action) {
      console.log(`Next action will ${action.action} ${resource.type} ${resource.id} at ${action.when}`);
      await startExecution(stateMachineArn, resource, action);
    } else {
      console.log(`No action scheduled for ${resource.type} ${resource.id}`);
    }
  }
}

export async function handler(event: any): Promise<any> {
  const stateMachineArn = event.StateMachine.Id;
  const input = event.Execution.Input;
  if (input.detail) {
    return handleCloudWatchEvent(stateMachineArn, input);
  } else {
    const action = input as AutoStateAction;
    if (action.resourceType === "ec2-instance"
        || action.resourceType === "rds-instance"
        || action.resourceType === "rds-cluster"
        || action.resourceType === "ecs-service") {
      return processStateAction(stateMachineArn, action);
    }
  }
}
