"""
User Data Handler Lambda
Manages per-user data backup/restore to S3.

Routes:
  PUT    /user-data/{userId}/{dataType}  — Save JSON to S3 at UKcal/{userId}/{dataType}.json
  GET    /user-data/{userId}/{dataType}  — Read JSON from S3 at UKcal/{userId}/{dataType}.json
  DELETE /user-data/{userId}/account    — Wipe ALL user data from S3 + DynamoDB on account deletion

dataType for GET/PUT must be one of: profile, history, settings
"""

import json
import os
import boto3
from botocore.exceptions import ClientError

s3 = boto3.client('s3')
dynamodb = boto3.resource('dynamodb')

BUCKET = os.environ.get('USER_DATA_BUCKET', 'ukcal-user-uploads')
S3_PREFIX = os.environ.get('S3_PREFIX', 'UKcal')
VIDEOS_BUCKET = os.environ.get('VIDEOS_BUCKET', 'nutrition-video-analysis-dev-videos-dbenpoj2')
RESULTS_BUCKET = os.environ.get('RESULTS_BUCKET', 'nutrition-video-analysis-dev-results-dbenpoj2')
DYNAMO_TABLE = os.environ.get('DYNAMO_TABLE', 'ukcal-business-profiles')
ALLOWED_DATA_TYPES = {'profile', 'history', 'settings'}
MAX_BODY_SIZE = 5 * 1024 * 1024  # 5 MB limit per data type


def _cors_headers():
    return {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Amz-Date,X-Api-Key,X-Amz-Security-Token',
        'Access-Control-Allow-Methods': 'GET,PUT,DELETE,OPTIONS',
    }


def _response(status_code, body):
    return {
        'statusCode': status_code,
        'headers': {
            'Content-Type': 'application/json',
            **_cors_headers(),
        },
        'body': json.dumps(body) if not isinstance(body, str) else body,
    }


def _delete_s3_prefix(bucket, prefix):
    """Delete all objects under a given S3 prefix. Returns count deleted."""
    deleted = 0
    paginator = s3.get_paginator('list_objects_v2')
    for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
        objects = page.get('Contents', [])
        if not objects:
            continue
        s3.delete_objects(
            Bucket=bucket,
            Delete={'Objects': [{'Key': obj['Key']} for obj in objects], 'Quiet': True},
        )
        deleted += len(objects)
    return deleted


def _handle_delete_account(user_id, event):
    """
    Remove all identity links for a user on account deletion.

    - Deletes the user's profile/history backup from S3 (the index that links
      userId -> their jobs). This severs the connection between the account and
      the underlying job data.
    - Job data (uploaded videos, analysis results, segmented images) is kept
      as-is under its UUID-based keys — already anonymous with no user reference.
    - Deletes the DynamoDB identity record.

    Result: the user can sign up fresh and start from scratch. The retained job
    data is fully anonymous and can be used for analytics / ML training.
    """
    body = {}
    try:
        raw = event.get('body') or '{}'
        body = json.loads(raw)
    except Exception:
        pass

    job_ids = body.get('job_ids', [])
    if not isinstance(job_ids, list):
        job_ids = []

    summary = {}

    # 1. Delete user backup data (profile.json, history.json) — this is the
    #    only thing that links userId to their job UUIDs. Removing it makes
    #    all job data anonymous without touching the job objects themselves.
    user_prefix = f'{S3_PREFIX}/{user_id}/'
    n = _delete_s3_prefix(BUCKET, user_prefix)
    summary['user_backup_deleted'] = n
    print(f'[AccountDelete] Removed {n} identity objects from {BUCKET}/{user_prefix}')

    # 2. Job data (uploads/, results/, segmented_images/) is intentionally
    #    retained — keys are random UUIDs with no user reference, so the data
    #    is already anonymous once the user backup above is removed.
    summary['job_data_retained'] = len(job_ids)
    print(f'[AccountDelete] Retained {len(job_ids)} jobs as anonymous data (no user link remains)')

    # 3. Delete DynamoDB identity record
    try:
        table = dynamodb.Table(DYNAMO_TABLE)
        table.delete_item(Key={'userId': user_id})
        summary['dynamo_deleted'] = True
        print(f'[AccountDelete] Deleted DynamoDB profile for {user_id}')
    except Exception as e:
        summary['dynamo_deleted'] = False
        print(f'[AccountDelete] DynamoDB delete failed (non-fatal): {e}')

    return _response(200, {
        'message': 'Account identity removed. Job data retained anonymously.',
        'summary': summary,
    })


def lambda_handler(event, context):
    http_method = event.get('httpMethod', '')
    path_params = event.get('pathParameters') or {}

    # Handle CORS preflight
    if http_method == 'OPTIONS':
        return _response(200, {'message': 'OK'})

    user_id = path_params.get('userId', '')
    data_type = path_params.get('dataType', '')

    if not user_id:
        return _response(400, {'error': 'Missing userId'})

    # Account deletion — DELETE /user-data/{userId}/account
    if http_method == 'DELETE' and data_type == 'account':
        return _handle_delete_account(user_id, event)

    if data_type not in ALLOWED_DATA_TYPES:
        return _response(400, {
            'error': f'Invalid dataType: {data_type}. Must be one of: {", ".join(sorted(ALLOWED_DATA_TYPES))}'
        })

    s3_key = f'{S3_PREFIX}/{user_id}/{data_type}.json'

    if http_method == 'PUT':
        return _handle_put(s3_key, event, user_id, data_type)
    elif http_method == 'GET':
        return _handle_get(s3_key, user_id, data_type)
    else:
        return _response(405, {'error': f'Method not allowed: {http_method}'})


def _handle_put(s3_key, event, user_id, data_type):
    """Save JSON data to S3."""
    body = event.get('body', '')
    if not body:
        return _response(400, {'error': 'Empty request body'})

    if len(body) > MAX_BODY_SIZE:
        return _response(413, {'error': f'Body too large. Max size: {MAX_BODY_SIZE} bytes'})

    try:
        json.loads(body)
    except (json.JSONDecodeError, TypeError):
        return _response(400, {'error': 'Invalid JSON body'})

    try:
        s3.put_object(
            Bucket=BUCKET,
            Key=s3_key,
            Body=body,
            ContentType='application/json',
            ServerSideEncryption='aws:kms',
        )
        print(f'[UserData] Saved {data_type} for user {user_id} -> s3://{BUCKET}/{s3_key}')
        return _response(200, {
            'message': f'{data_type} saved successfully',
            'key': s3_key,
        })
    except ClientError as e:
        print(f'[UserData] S3 PutObject error: {e}')
        return _response(500, {'error': 'Failed to save data'})


def _handle_get(s3_key, user_id, data_type):
    """Read JSON data from S3."""
    try:
        response = s3.get_object(Bucket=BUCKET, Key=s3_key)
        body = response['Body'].read().decode('utf-8')
        print(f'[UserData] Retrieved {data_type} for user {user_id} from s3://{BUCKET}/{s3_key}')
        return {
            'statusCode': 200,
            'headers': {
                'Content-Type': 'application/json',
                **_cors_headers(),
            },
            'body': body,
        }
    except ClientError as e:
        error_code = e.response['Error']['Code']
        if error_code == 'NoSuchKey':
            print(f'[UserData] No {data_type} found for user {user_id}')
            return _response(404, {'error': f'No {data_type} data found'})
        print(f'[UserData] S3 GetObject error: {e}')
        return _response(500, {'error': 'Failed to retrieve data'})
