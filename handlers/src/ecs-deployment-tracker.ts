import {ECSClient, ListTagsForResourceCommand, TagResourceCommand, UntagResourceCommand} from "@aws-sdk/client-ecs";

const ecsClient = new ECSClient({});
const ECS_REQUIRED_TAG_KEY = 'autostate:max-runtime';

export async function applyLatestTag(serviceArn: string): Promise<boolean> {
  console.info(`Processing ECS service tags for service: ${serviceArn}`);
  try {
    const tagData = await ecsClient.send(new ListTagsForResourceCommand({ resourceArn: serviceArn }));
    const tags = tagData.tags;

    const hasRequiredTag = tags.some(tag => tag.key === ECS_REQUIRED_TAG_KEY);

    if (!hasRequiredTag) {
      console.info('Service does not have the required tag. Exiting without action.');
      return false;
    }

    console.info('Service has the required tag. Proceeding with further actions.');

    const requiredTag = tags.find(tag => tag.key === ECS_REQUIRED_TAG_KEY);

    await ecsClient.send(new UntagResourceCommand({
      resourceArn: serviceArn,
      tagKeys: [ECS_REQUIRED_TAG_KEY]
    }));
    console.log('Tag successfully cleared.');

    await ecsClient.send(new TagResourceCommand({
      resourceArn: serviceArn,
      tags: [{
        key: requiredTag.key,
        value: requiredTag.value
      }]
    }));
    console.log('Tag successfully applied again.');

    return true;

  } catch (error) {
    console.error('Error processing ECS service tags:', error);
    throw new Error(`Error processing ECS service tags: ${error}`);
  }
}

export async function handler(event: any): Promise<any> {
  console.info('Received event:', JSON.stringify(event));

  const serviceArnList: string[] = event.resources;

  for (const serviceArn of serviceArnList) {
    try {
      await applyLatestTag(serviceArn);
    }catch (error) {
      console.error('Error processing ECS service tags:', error);
    }
  }
}

