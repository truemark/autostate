jest.mock("@aws-sdk/client-ecs", () => {

  const actualEcs = jest.requireActual("@aws-sdk/client-ecs");

  const sendMock = jest.fn((command) => {
    if (command instanceof actualEcs.ListTagsForResourceCommand) {
      return Promise.resolve({ tags: [{ key: 'autostate:max-runtime', value: '3600' }] });
    }
    if (command instanceof actualEcs.UntagResourceCommand || command instanceof actualEcs.TagResourceCommand) {
      return Promise.resolve();
    }
    return Promise.reject(new Error("Command not implemented in mock"));
  });

  return {
    ECSClient: jest.fn().mockImplementation(() => ({
      send: sendMock
    })),
    ListTagsForResourceCommand: actualEcs.ListTagsForResourceCommand,
    TagResourceCommand: actualEcs.TagResourceCommand,
    UntagResourceCommand: actualEcs.UntagResourceCommand,
  };
});

import { ECSClient } from "@aws-sdk/client-ecs";
import * as sut from './ecs-deployment-tracker';

describe('ECS Tagging Operations', () => {
  let ecsClientInstance: ECSClient;

  const serviceArn = "arn:aws:ecs:region:account-id:service/service-name";

  beforeEach(() => {
    jest.clearAllMocks();
    ecsClientInstance = new ECSClient({});
  });


  it('should successfully apply latest tag when required tag is present', async () => {
    const result = await sut.applyLatestTag(serviceArn);
    expect(result).toBeTruthy();
    expect(ecsClientInstance.send).toHaveBeenCalledTimes(3);
  });

  it('should exit without action if required tag is not present', async () => {
    (ecsClientInstance.send as jest.Mock).mockResolvedValueOnce({ tags: [{ key: 'other-tag', value: '1000' }] });
    const result = await sut.applyLatestTag(serviceArn);
    expect(result).toBeFalsy();
    expect(ecsClientInstance.send).toHaveBeenCalledTimes(1);
  });

  it('should handle errors during tagging process', async () => {
    (ecsClientInstance.send as jest.Mock).mockRejectedValueOnce(new Error('AWS Error'));
    await expect(sut.applyLatestTag(serviceArn)).rejects.toThrow('AWS Error');
  });
});

describe('ECS Service Handler', () => {
  let ecsClientInstance: ECSClient;
  const serviceArn1 = "arn:aws:ecs:region:account-id:service/service-name-1";
  const serviceArn2 = "arn:aws:ecs:region:account-id:service/service-name-2";

  beforeEach(() => {
    jest.clearAllMocks();
    ecsClientInstance = new ECSClient({});
  });

  it('should process multiple services', async () => {
    const event = { resources: [serviceArn1, serviceArn2] };
    await sut.handler(event);
    expect(ecsClientInstance.send).toHaveBeenCalledTimes(6); // Each service calls `send` three times
  });
});
