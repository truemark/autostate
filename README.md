# Auto State

This AWS CDK project deploys resources to automatically start, stop, reboot and terminate resources.

## Supported Resource Types
 * EC2 Instances
 * RDS Instances
 * ECS Services

## Supported Tags

| Tag                       | Description                                                                               |
|---------------------------|-------------------------------------------------------------------------------------------|
| autostate:timezone        | The timezone to use when interpreting schedules. Defaults to UTC. Example: America/Denver |
| autostate:start-schedule  | The schedule as a cron expression to start the resource. Example: 0 8 * * 1-5             |
| autostate:stop-schedule   | The schedule as a cron expression to stop the resource. Example: 0 18 * * 1-5             |
| autostate:reboot-schedule | The schedule as a cron expression to reboot the instance. Example: 0 12 * * 1-5           |
| autostate:max-runtime     | The number of minutes the resource may run before being stopped.                          |
| autostate:max-lifetime    | The number of minutes the resource may exist before being terminated.                     |

Con Expressions
```
*    *    *    *    *    *
┬    ┬    ┬    ┬    ┬    ┬
│    │    │    │    │    |
│    │    │    │    │    └ day of week (0 - 7, 1L - 7L) (0 or 7 is Sun)
│    │    │    │    └───── month (1 - 12)
│    │    │    └────────── day of month (1 - 31, L)
│    │    └─────────────── hour (0 - 23)
│    └──────────────────── minute (0 - 59)
└───────────────────────── second (0 - 59, optional)
```

## Caveats

 * RDS doesn't allow asterisks in tag values so use hyphens instead when defining cron expressions
 * terminate-schedule and reboot-schedule tags are ignored for ECS services
 * RDS doesn't allow termination of RDS clusters when they are stopped

Examples:

 * `0 8 * * 1-5` - 8am on weekdays
 * `0 18 * * 0,6` - 6pm on weekends
 * `0 12 * * *` - 12pm every day

## References

This project is also published as a AWS CDK Construct for use in your own stacks.
See https://github.com/truemark/cdk-autostate
