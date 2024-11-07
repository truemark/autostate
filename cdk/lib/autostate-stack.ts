import {Construct} from 'constructs';
import {AutoState} from './autostate-construct';
import * as p from '../../package.json';
import {ExtendedStack, ExtendedStackProps} from 'truemark-cdk-lib/aws-cdk';

export class AutoStateStack extends ExtendedStack {
  constructor(scope: Construct, id: string, props: ExtendedStackProps) {
    super(scope, id, props);
    this.outputParameter('Name', 'AutoState');
    this.outputParameter('Version', p.version);
    new AutoState(this, 'AutoState', {});
  }
}
