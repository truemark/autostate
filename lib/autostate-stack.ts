import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import {AutoState} from "./autostate-construct";
import * as p from "../package.json";

export class AutoStateStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    this.addMetadata("Version", p.version);
    this.addMetadata("Name", p.name);
    this.addMetadata("RepositoryType", p.repository.type);
    this.addMetadata("Repository", p.repository.url);
    this.addMetadata("Homepage", p.homepage);
    new AutoState(this, "AutoState", {});
  }
}
