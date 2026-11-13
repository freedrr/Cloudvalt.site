import 'dotenv/config';
import {
  GetBucketCorsCommand,
  PutBucketCorsCommand,
  S3Client,
} from '@aws-sdk/client-s3';

const {
  B2_KEY_ID,
  B2_APPLICATION_KEY,
  B2_BUCKET_NAME,
  B2_REGION = 'us-east-005',
  B2_ENDPOINT = `https://s3.${B2_REGION}.backblazeb2.com`,
} = process.env;

if (!B2_KEY_ID || !B2_APPLICATION_KEY || !B2_BUCKET_NAME) {
  console.error('Missing B2_KEY_ID, B2_APPLICATION_KEY, or B2_BUCKET_NAME in .env');
  process.exit(1);
}

const s3 = new S3Client({
  endpoint: B2_ENDPOINT.startsWith('http') ? B2_ENDPOINT : `https://${B2_ENDPOINT}`,
  region: B2_REGION,
  credentials: { accessKeyId: B2_KEY_ID, secretAccessKey: B2_APPLICATION_KEY },
  forcePathStyle: true,
});

const origins = (process.env.CLOUDVALT_CORS_ORIGINS || 'http://localhost:3000')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

try {
  let existingRules = [];
  try {
    const current = await s3.send(new GetBucketCorsCommand({ Bucket: B2_BUCKET_NAME }));
    existingRules = current.CORSRules || [];
    console.log(`Read ${existingRules.length} existing CORS rule(s).`);
  } catch (error) {
    if (error.name !== 'NoSuchCORSConfiguration') throw error;
    console.log('No existing S3 CORS rules found.');
  }

  const uploadRule = {
    AllowedOrigins: origins,
    AllowedMethods: ['GET', 'PUT', 'POST', 'DELETE', 'HEAD'],
    AllowedHeaders: ['*'],
    ExposeHeaders: ['ETag', 'x-amz-request-id', 'x-amz-id-2'],
    MaxAgeSeconds: 3600,
  };

  // Preserve all custom rules and add the upload rule only if it is not already covered.
  const hasUploadRule = existingRules.some((rule) =>
    ['GET', 'PUT', 'POST', 'DELETE', 'HEAD'].every((method) => (rule.AllowedMethods || []).includes(method)) &&
    ['etag', 'x-amz-request-id', 'x-amz-id-2'].every((header) => (rule.ExposeHeaders || []).some((exposed) => exposed.toLowerCase() === header)) &&
    origins.every((origin) => (rule.AllowedOrigins || []).includes(origin))
  );
  const rules = hasUploadRule ? existingRules : [...existingRules, uploadRule];

  await s3.send(new PutBucketCorsCommand({
    Bucket: B2_BUCKET_NAME,
    CORSConfiguration: { CORSRules: rules },
  }));

  console.log(`CORS rules updated for bucket ${B2_BUCKET_NAME}.`);
  console.log(`Allowed upload origins: ${origins.join(', ')}`);
  console.log('Existing custom rules were preserved.');
} catch (error) {
  console.error('Could not update bucket CORS rules:', error.message || error);
  process.exitCode = 1;
} finally {
  s3.destroy();
}
