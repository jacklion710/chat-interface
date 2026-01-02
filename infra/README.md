# Infrastructure (AWS CDK)

This directory contains the AWS CDK app for deploying infrastructure needed to synchronize vector stores to S3.

## Prereqs

- AWS credentials configured locally (for the AWS account/region you want to deploy into)
- AWS CDK installed (`cdk --version`)

## Install dependencies

You can install from the repo root:

```bash
npm --prefix infra install
```

Or install inside `infra/`:

```bash
cd infra
npm install
```

## Bootstrap (one-time per account/region)

From `infra/`:

```bash
npx cdk bootstrap
```

## Configure

CDK context is read from `infra/cdk.json` under the `vectorStoreSync` key.

Example (import an existing bucket, do not create/replace it):

```json
{
  "app": "npx ts-node --project tsconfig.json bin/chat-interface-infra.ts",
  "context": {
    "vectorStoreSync": {
      "existingVectorStoreBucketName": "my-existing-bucket-name",
      "vectorStorePrefix": "vector-stores/",
      "assumeRolePrincipalArn": "arn:aws:iam::123456789012:role/MyAppRuntimeRole"
    }
  }
}
```

Notes:
- `existingVectorStoreBucketName`: if set, CDK **imports** the bucket and will not try to create it.
- `vectorStoreBucketName`: only used when creating a new bucket.
- `destroyOnRemoval`: defaults to `false` (bucket retained). Set to `true` only for ephemeral dev stacks.

## Deploy

From `infra/`:

```bash
npx cdk deploy
```

Outputs include:
- Bucket name/ARN
- Prefix
- IAM role ARN your app should assume to access S3

## App configuration for S3 mirroring

The Node server can optionally mirror vector store operations to S3.

Environment variables:
- `VECTOR_STORE_S3_BUCKET`: S3 bucket name (required to enable mirroring)
- `VECTOR_STORE_S3_PREFIX`: key prefix (defaults to `vector-stores/`)
- `VECTOR_STORE_S3_REGION`: AWS region for S3 (defaults to `AWS_REGION` / `AWS_DEFAULT_REGION`)
- `VECTOR_STORE_S3_ROLE_ARN`: optional role to assume via STS before calling S3



