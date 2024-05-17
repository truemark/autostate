import {ECSClient, ListTagsForResourceCommand, TagResourceCommand, UntagResourceCommand} from "@aws-sdk/client-ecs";

const ecs = new ECSClient({});
const ECS_REQUIRED_TAG_KEY = 'autostate:max-runtime';

export async function handler(event: any): Promise<any> {
  console.log('Received event:', JSON.stringify(event));

  const serviceArn = event.detail.serviceArn;

  try {
    const tagData = await ecs.send(new ListTagsForResourceCommand({ resourceArn: serviceArn }));
    const tags = tagData.tags;

    const hasRequiredTag = tags.some(tag => tag.key === ECS_REQUIRED_TAG_KEY);

    if (!hasRequiredTag) {
      console.log('Service does not have the required tag. Exiting without action.');
      return;
    }

    console.log('Service has the required tag. Proceeding with further actions.');

    const requiredTag = tags.find(tag => tag.key === ECS_REQUIRED_TAG_KEY);

    await ecs.send(new UntagResourceCommand({
      resourceArn: serviceArn,
      tagKeys: [ECS_REQUIRED_TAG_KEY]
    }));
    console.log('Tag successfully cleared.');

    await ecs.send(new TagResourceCommand({
      resourceArn: serviceArn,
      tags: [{
        key: requiredTag.key,
        value: requiredTag.value
      }]
    }));
    console.log('Tag successfully applied again.');

    return { status: 'success' };

  } catch (error) {
    console.error('Error processing ECS service tags:', error);
    throw new Error(`Error processing ECS service tags: ${error}`);
  }
}

