import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

type GitHubOidcContext = {
  owner?: string;
  repo?: string;
  branch?: string;
  roleName?: string;
};

function readGitHubOidcContext(scope: Construct): Required<GitHubOidcContext> {
  const raw = (scope.node.tryGetContext('githubOidc') ?? {}) as GitHubOidcContext;

  const owner = (raw.owner ?? '').trim();
  const repo = (raw.repo ?? '').trim();
  const branch = (raw.branch ?? 'main').trim();
  const roleName = (raw.roleName ?? 'ChatInterfaceGitHubDeployRole').trim();

  if (!owner || !repo) {
    throw new Error(
      "Missing CDK context githubOidc.owner/repo. Set in infra/cdk.json, e.g. { \"context\": { \"githubOidc\": { \"owner\": \"ORG\", \"repo\": \"REPO\" } } }",
    );
  }

  return { owner, repo, branch, roleName };
}

export class GitHubOidcDeployRoleStack extends cdk.Stack {
  public readonly deployRoleArn: string;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const ctx = readGitHubOidcContext(this);

    const provider = new iam.OpenIdConnectProvider(this, 'GitHubOidcProvider', {
      url: 'https://token.actions.githubusercontent.com',
      clientIds: ['sts.amazonaws.com'],
      thumbprints: ['6938fd4d98bab03faadb97b34396831e3780aea1'],
    });

    const deployRole = new iam.Role(this, 'GitHubDeployRole', {
      roleName: ctx.roleName,
      assumedBy: new iam.OpenIdConnectPrincipal(provider).withConditions({
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
        },
        StringLike: {
          'token.actions.githubusercontent.com:sub': `repo:${ctx.owner}/${ctx.repo}:ref:refs/heads/${ctx.branch}`,
        },
      }),
    });

    deployRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AdministratorAccess'));

    this.deployRoleArn = deployRole.roleArn;
    new cdk.CfnOutput(this, 'GitHubDeployRoleArn', { value: deployRole.roleArn });
  }
}


