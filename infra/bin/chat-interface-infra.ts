import * as cdk from 'aws-cdk-lib';
import { VectorStoreSyncStack } from '../lib/vector-store-sync-stack';
import { GitHubOidcDeployRoleStack } from '../lib/github-oidc-deploy-role-stack';
import { WebAppStack } from '../lib/web-app-stack';

const app = new cdk.App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

const githubOidc = (app.node.tryGetContext('githubOidc') ?? {}) as { owner?: string; repo?: string };
const githubOwner = (githubOidc.owner ?? '').trim();
const githubRepo = (githubOidc.repo ?? '').trim();

if (githubOwner && githubRepo) {
  new GitHubOidcDeployRoleStack(app, 'ChatInterfaceGitHubOidcStack', {
    env: {
      account: env.account,
      region: env.region,
    },
  });
}

const vectorStoreSyncStack = new VectorStoreSyncStack(app, 'ChatInterfaceVectorStoreSyncStack', {
  env: {
    account: env.account,
    region: env.region,
  },
});

new WebAppStack(app, 'ChatInterfaceWebAppStack', {
  env: {
    account: env.account,
    region: env.region,
  },
  vectorStoreBucketName: vectorStoreSyncStack.vectorStoreBucketName,
  vectorStorePrefix: vectorStoreSyncStack.vectorStorePrefix,
  vectorStoreRegion: env.region ?? 'us-east-1',
  vectorStoreS3AccessPolicy: vectorStoreSyncStack.vectorStoreS3AccessPolicy,
});


