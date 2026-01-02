import * as cdk from 'aws-cdk-lib';
import { VectorStoreSyncStack } from '../lib/vector-store-sync-stack';

const app = new cdk.App();

new VectorStoreSyncStack(app, 'ChatInterfaceVectorStoreSyncStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});


