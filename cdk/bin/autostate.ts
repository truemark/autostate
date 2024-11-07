#!/usr/bin/env node
import 'source-map-support/register';
import {AutoStateStack} from '../lib/autostate-stack';
import {ExtendedApp} from 'truemark-cdk-lib/aws-cdk';

const app = new ExtendedApp({
  standardTags: {
    automationTags: {
      id: 'autostate',
      url: 'https://github.com/truemark/autostate',
    },
  },
});
new AutoStateStack(app, 'AutoState', {});
