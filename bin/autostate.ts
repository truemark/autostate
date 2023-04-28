#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { AutoStateStack } from '../lib/autostate-stack';

const app = new cdk.App();
new AutoStateStack(app, 'AutoStateStack', {});
