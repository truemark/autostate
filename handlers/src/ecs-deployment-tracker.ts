import {ECSClient, ListTagsForResourceCommand, TagResourceCommand, UntagResourceCommand} from "@aws-sdk/client-ecs";

const ecsClient = new ECSClient({});
const ECS_REQUIRED_TAG_KEY = 'autostate:max-runtime';

export async function applyLatestTag(serviceArn: string): Promise<boolean> {
  try {
    const tagData = await ecsClient.send(new ListTagsForResourceCommand({ resourceArn: serviceArn }));
    const tags = tagData.tags;

    const hasRequiredTag = tags.some(tag => tag.key === ECS_REQUIRED_TAG_KEY);

    if (!hasRequiredTag) {
      return false;
    }

    console.info('Service has the required tag. Proceeding with further actions.');

    const requiredTag = tags.find(tag => tag.key === ECS_REQUIRED_TAG_KEY);

    await ecsClient.send(new UntagResourceCommand({
      resourceArn: serviceArn,
      tagKeys: [ECS_REQUIRED_TAG_KEY]
    }));

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
    throw new Error(`Error processing ECS service tags: ${error}`);
  }
}

export async function handler(event: any): Promise<any> {
  const serviceArnList: string[] = event.resources;

  for (const serviceArn of serviceArnList) {
    try {
      await applyLatestTag(serviceArn);
    }catch (error) {
      console.error('Error processing ECS service tags:', error);
    }
  }
}

