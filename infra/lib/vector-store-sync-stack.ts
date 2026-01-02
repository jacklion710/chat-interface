import * as cdk from 'aws-cdk-lib';
import { RemovalPolicy } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

type ContextConfig = {
  existingVectorStoreBucketName?: string;
  vectorStoreBucketName?: string;
  vectorStorePrefix?: string;
  destroyOnRemoval?: boolean;
  assumeRolePrincipalArn?: string;
};

function readContextConfig(scope: Construct): Required<Pick<ContextConfig, 'vectorStorePrefix' | 'destroyOnRemoval'>> &
  Omit<ContextConfig, 'vectorStorePrefix' | 'destroyOnRemoval'> {
  const raw = (scope.node.tryGetContext('vectorStoreSync') ?? {}) as ContextConfig;

  return {
    existingVectorStoreBucketName: raw.existingVectorStoreBucketName,
    vectorStoreBucketName: raw.vectorStoreBucketName,
    vectorStorePrefix: raw.vectorStorePrefix ?? 'vector-stores/',
    destroyOnRemoval: raw.destroyOnRemoval ?? false,
    assumeRolePrincipalArn: raw.assumeRolePrincipalArn,
  };
}

export class VectorStoreSyncStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const config = readContextConfig(this);
    const prefix = config.vectorStorePrefix.endsWith('/') ? config.vectorStorePrefix : `${config.vectorStorePrefix}/`;

    const bucket = config.existingVectorStoreBucketName
      ? s3.Bucket.fromBucketName(this, 'VectorStoresBucket', config.existingVectorStoreBucketName)
      : new s3.Bucket(this, 'VectorStoresBucket', {
          bucketName: config.vectorStoreBucketName,
          versioned: true,
          encryption: s3.BucketEncryption.S3_MANAGED,
          blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
          enforceSSL: true,
          removalPolicy: config.destroyOnRemoval ? RemovalPolicy.DESTROY : RemovalPolicy.RETAIN,
          autoDeleteObjects: config.destroyOnRemoval,
          lifecycleRules: [
            {
              abortIncompleteMultipartUploadAfter: cdk.Duration.days(7),
            },
          ],
        });

    const assumedBy = config.assumeRolePrincipalArn
      ? new iam.ArnPrincipal(config.assumeRolePrincipalArn)
      : new iam.AccountRootPrincipal();

    const s3AccessPolicy = new iam.ManagedPolicy(this, 'VectorStoreSyncS3AccessPolicy', {
      description: 'Least-privilege access to sync vector store files to the vector store S3 bucket.',
      statements: [
        new iam.PolicyStatement({
          sid: 'ListBucketInPrefix',
          actions: ['s3:ListBucket'],
          resources: [bucket.bucketArn],
          conditions: {
            StringLike: {
              's3:prefix': [prefix, `${prefix}*`],
            },
          },
        }),
        new iam.PolicyStatement({
          sid: 'ObjectReadWriteInPrefix',
          actions: [
            's3:GetObject',
            's3:GetObjectTagging',
            's3:PutObject',
            's3:PutObjectTagging',
            's3:DeleteObject',
            's3:AbortMultipartUpload',
            's3:ListMultipartUploadParts',
          ],
          resources: [bucket.arnForObjects(`${prefix}*`)],
        }),
      ],
    });

    const appRole = new iam.Role(this, 'VectorStoreSyncAppRole', {
      assumedBy,
      description: 'Role intended for the chat-interface app to sync vector store files to S3.',
    });

    appRole.addManagedPolicy(s3AccessPolicy);

    new cdk.CfnOutput(this, 'VectorStoreBucketName', { value: bucket.bucketName });
    new cdk.CfnOutput(this, 'VectorStoreBucketArn', { value: bucket.bucketArn });
    new cdk.CfnOutput(this, 'VectorStorePrefix', { value: prefix });
    new cdk.CfnOutput(this, 'VectorStoreSyncRoleArn', { value: appRole.roleArn });
    new cdk.CfnOutput(this, 'VectorStoreSyncManagedPolicyArn', { value: s3AccessPolicy.managedPolicyArn });
  }
}


