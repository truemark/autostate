# Change Log

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.1]

### Added

-   Idle detection for EC2 instances. Stops an instance when CPU, network and established TCP connection metrics all stay below their thresholds for a sustained window, evaluated by a CloudWatch composite alarm per instance rather than by polling
-   `autostate:idle-detection` tag with `enabled`, `notify-only` and `disabled` modes, where `notify-only` records a decision for every idle instance without stopping anything
-   `autostate:idle-threshold` tag carrying every idle threshold in one value as `duration/grace/cpu-max/network-max/connections-max`. Blank fields take their defaults, trailing fields may be omitted, and any signal may be set to `off`
-   `autostate:hold-until` tag to pin an instance running until a given timestamp regardless of its metrics
-   Automatic calibration of the connection threshold when `connections-max` is `auto`, measuring the instance's own quiet floor instead of assuming zero
-   Daily sweep that reconciles instance tags against their alarms and removes alarms belonging to terminated or opted-out instances
-   Idle detection falls back to `notify-only`, with the reason logged, when no connection signal is configured or when a configured threshold cannot be resolved. Missing metric data never counts as idle, so a failed CloudWatch agent prevents stops rather than causing them

### Changed

-   Documented existing SageMaker Notebook Instance support

## [1.2.0]

### Changed

-   Moved to Node 20 runtime
-   Moved from GTS to standard eslint and prettier config
-   Moved cdk to cdk folder
-   Moved to ES modules for handlers
