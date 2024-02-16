These are samples of the 5 specific events that AutoState listens for. Each one is different. The code needs to allow for each of these events to be processed within the same chunk of code, in such a way that eslint does not bark.

This is a challenge, because specific elements exist in some events and not others. For example, the EcsStartRule has many items under detail. The RDS events do not have anywhere near the same number of items. I could create a composite type for these events, but 1. that would be huge, 2. Some items would have to be optional even though they are required in other events, and this defeats the purpose of a linter, and 3. I tried it and ran into code errors, where it expected items to be present (and weren't). 

I could only declare the pieces I need, but then what is the point of the interface? In order to make that work, I think I'd need to disable a rule in eslint. I don't want to do that, either. I could declare everything as not required, but that defeats the purpose also. 

handleCloudwatchEvent is quite problematic. Each event has a detail type. I'm thinking I can make eslint happy by creating a 


Tag Change on Resource, handled by TagRule. The code that responds to this event 

```
{
  "version": "0",
  "id": "6886abbc-2f46-a604-2640-9b2c028984a7",
  "detail-type": "Tag Change on Resource",
  "source": "aws.tag",
  "account": "123456789012",
  "time": "2018-09-25T00:46:47Z",
  "region": "us-east-1",
  "resources": ["arn:aws-us-gov:dynamodb:us-east-1:123456789012:table/Test"],
  "detail": {
    "changed-tag-keys": ["cwe-test-tag"],
    "service": "dynamodb",
    "resource-type": "table",
    "version": 1,
    "tags": {
      "cwe-test-tag": "tag"
    }
  }
}
```

RDS DB Instance Event, handled by RdsStartRule
```
{
  "version": "0",
  "id": "68f6e973-1a0c-d37b-f2f2-94a7f62ffd4e",
  "detail-type": "RDS DB Instance Event",
  "source": "aws.rds",
  "account": "123456789012",
  "time": "2018-09-27T22:36:43Z",
  "region": "us-east-1",
  "resources": ["arn:aws:rds:us-east-1:123456789012:db:mysql-instance-2018-10-06-12-24"],
  "detail": {
    "EventCategories": ["failover"],
    "SourceType": "DB_INSTANCE",
    "SourceArn": "arn:aws:rds:us-east-1:123456789012:db:mysql-instance-2018-10-06-12-24e",
    "Date": "2018-09-27T22:36:43.292Z",
    "SourceIdentifier": "mysql-instance-2018-10-06-12-24",
    "Message": "A Multi-AZ failover has completed.",
    "EventID": "RDS-EVENT-0049"
  }
}
```
RDS DB Cluster Event, also handled by RdsStartRule. Thankfully, the format is the same as RDS DB Instance Event.
```
{
  "version": "0",
  "id": "844e2571-85d4-695f-b930-0153b71dcb42",
  "detail-type": "RDS DB Cluster Event",
  "source": "aws.rds",
  "account": "123456789012",
  "time": "2018-10-06T12:26:13Z",
  "region": "us-east-1",
  "resources": ["arn:aws:rds:us-east-1:123456789012:cluster:mysql-cluster-2018-10-06-12-24"],
  "detail": {
    "EventCategories": ["notification"],
    "SourceType": "CLUSTER",
    "SourceArn": "arn:aws:rds:us-east-1:123456789012:cluster:mysql-cluster-2018-10-06-12-24",
    "Date": "2018-10-06T12:26:13.882Z",
    "SourceIdentifier": "mysql-instance-2018-10-06-12-24",
    "Message": "DB cluster created",
    "EventID": "RDS-EVENT-0170"
  }
}
```
EC2 Instance State Change, handled by Ec2StartRule. The rule filters for state 'running', 
```
{
  "version": "0",
  "id": "7bf73129-1428-4cd3-a780-95db273d1602",
  "detail-type": "EC2 Instance State-change Notification",
  "source": "aws.ec2",
  "account": "123456789012",
  "time": "2015-11-11T21:29:54Z",
  "region": "us-east-1",
  "resources": ["arn:aws:ec2:us-east-1:123456789012:instance/i-abcd1111"],
  "detail": {
    "instance-id": "i-abcd1111",
    "state": "running"
  }
}
```
EcsStartRule, handled by EcsStartRule

```
{
  "version": "0",
  "id": "a1aa69ff-66e8-c3eb-2e47-3776ac5935dd",
  "detail-type": "AWS API Call via CloudTrail",
  "source": "aws.resource-groups",
  "account": "123456789012",
  "time": "2022-02-17T09:42:52Z",
  "region": "us-east-1",
  "resources": [],
  "detail": {
    "eventVersion": "1.08",
    "userIdentity": {
      "type": "AssumedRole",
      "principalId": "XYZZYOR:admin",
      "arn": "arn:aws:sts::123456789012:role/admin",
      "accountId": "123456789012",
      "accessKeyId": "XYZZY",
      "sessionContext": {
        "sessionIssuer": {
          "type": "Role",
          "principalId": "XYZZYOR",
          "arn": "arn:aws:iam::123456789012:role/Admin",
          "accountId": "123456789012",
          "userName": "Admin"
        },
        "webIdFederationData": {},
        "attributes": {
          "creationDate": "2022-02-17T09:41:02Z",
          "mfaAuthenticated": "false"
        }
      }
    },
    "eventTime": "2022-02-17T09:42:52Z",
    "eventSource": "resource-groups.amazonaws.com",
    "eventName": "CreateGroup",
    "awsRegion": "us-east-1",
    "sourceIPAddress": "52.94.133.138",
    "userAgent": "aws-cli/2.2.31 Python/3.8.8 Darwin/20.6.0 exe/x86_64 prompt/off command/resource-groups.create-group",
    "requestParameters": {
      "Description": "test6",
      "Name": "test301",
      "ResourceQuery": {
        "Type": "CLOUDFORMATION_STACK_1_0",
        "Query": "{ \"ResourceTypeFilters\": [ \"AWS::AllSupported\" ], \"StackIdentifier\": \"arn:aws:cloudformation:us-east-1:123456789012:stack/test/aa434df0-fe92-11eb-bde9-0a03f460991d\"}"
      }
    },
    "responseElements": {
      "Group": {
        "GroupArn": "arn:aws:resource-groups:us-east-1:123456789012:group/test301",
        "Name": "test301",
        "Description": "test6",
        "OwnerId": "123456789012"
      },
      "ResourceQuery": {
        "Type": "CLOUDFORMATION_STACK_1_0",
        "Query": "{ \"ResourceTypeFilters\": [ \"AWS::AllSupported\" ], \"StackIdentifier\": \"arn:aws:cloudformation:us-east-1:123456789012:stack/test/aa434df0-fe92-11eb-bde9-0a03f460991d\"}"
      }
    },
    "requestID": "31cabb57-0931-4cdb-b66b-137267531dd1",
    "eventID": "4d51d885-3d1f-4579-bf42-96924aadbc3f",
    "readOnly": false,
    "eventType": "AwsApiCall",
    "managementEvent": true,
    "recipientAccountId": "123456789012",
    "eventCategory": "Management"
  }
}
```


