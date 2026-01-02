import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecsPatterns from 'aws-cdk-lib/aws-ecs-patterns';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { resolve } from 'node:path';
import { Construct } from 'constructs';

export type WebAppStackProps = cdk.StackProps & {
  vectorStoreBucketName: string;
  vectorStorePrefix: string;
  vectorStoreRegion: string;
  vectorStoreS3AccessPolicy: iam.IManagedPolicy;
};

type WebAppContext = {
  openaiApiKeySecretArn?: string;
};

function readWebAppContext(scope: Construct): WebAppContext {
  return (scope.node.tryGetContext('webApp') ?? {}) as WebAppContext;
}

export class WebAppStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: WebAppStackProps) {
    super(scope, id, props);

    const ctx = readWebAppContext(this);

    const vpc = new ec2.Vpc(this, 'WebAppVpc', {
      natGateways: 0,
      maxAzs: 2,
      subnetConfiguration: [
        {
          name: 'public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
      ],
    });

    const cluster = new ecs.Cluster(this, 'WebAppCluster', {
      vpc,
      containerInsights: true,
    });

    const logGroup = new logs.LogGroup(this, 'WebAppLogs', {
      retention: logs.RetentionDays.ONE_WEEK,
    });

    const openaiSecret =
      ctx.openaiApiKeySecretArn && ctx.openaiApiKeySecretArn.trim().length > 0
        ? secretsmanager.Secret.fromSecretCompleteArn(this, 'OpenAIApiKeySecret', ctx.openaiApiKeySecretArn.trim())
        : new secretsmanager.Secret(this, 'OpenAIApiKeySecret', {
            description: 'OpenAI API key for chat-interface (set this secret value after deployment).',
          });

    const service = new ecsPatterns.ApplicationLoadBalancedFargateService(this, 'WebAppService', {
      cluster,
      publicLoadBalancer: true,
      assignPublicIp: true,
      desiredCount: 1,
      cpu: 512,
      memoryLimitMiB: 1024,
      listenerPort: 80,
      taskImageOptions: {
        image: ecs.ContainerImage.fromAsset(resolve(__dirname, '../..')),
        containerPort: 4000,
        enableLogging: true,
        logDriver: ecs.LogDrivers.awsLogs({
          logGroup,
          streamPrefix: 'web',
        }),
        environment: {
          PORT: '4000',
          VECTOR_STORE_S3_BUCKET: props.vectorStoreBucketName,
          VECTOR_STORE_S3_PREFIX: props.vectorStorePrefix,
          VECTOR_STORE_S3_REGION: props.vectorStoreRegion,
        },
        secrets: {
          OPENAI_API_KEY: ecs.Secret.fromSecretsManager(openaiSecret),
        },
      },
    });

    service.targetGroup.configureHealthCheck({
      path: '/',
      healthyHttpCodes: '200-399',
    });

    service.taskDefinition.taskRole.addManagedPolicy(props.vectorStoreS3AccessPolicy);

    service.taskDefinition.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'AllowOpenAISecretRead',
        actions: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'],
        resources: [openaiSecret.secretArn],
      }),
    );

    new cdk.CfnOutput(this, 'WebAppUrl', { value: `http://${service.loadBalancer.loadBalancerDnsName}` });
    new cdk.CfnOutput(this, 'OpenAIApiKeySecretArn', { value: openaiSecret.secretArn });
  }
}


