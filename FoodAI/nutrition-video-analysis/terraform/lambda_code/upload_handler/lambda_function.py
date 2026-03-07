import json
import os
import uuid
import boto3
from botocore.config import Config
from datetime import datetime
import base64

# Configure S3 client with signature version 4 for KMS-encrypted buckets
s3_config = Config(signature_version='s3v4')
s3 = boto3.client('s3', config=s3_config)
dynamodb = boto3.resource('dynamodb')
sqs = boto3.client('sqs')
lambda_client = boto3.client('lambda')

S3_VIDEOS_BUCKET = os.environ.get('S3_VIDEOS_BUCKET')
DYNAMODB_JOBS_TABLE = os.environ.get('DYNAMODB_JOBS_TABLE')
SQS_VIDEO_QUEUE_URL = os.environ.get('SQS_VIDEO_QUEUE_URL')
# Name of the gemini_processor Lambda function (set this env var after deploying it)
GEMINI_PROCESSOR_LAMBDA = os.environ.get('GEMINI_PROCESSOR_LAMBDA_NAME', 'gemini_processor')


def lambda_handler(event, context):
    """Handle video upload - returns presigned URL or processes base64 upload."""

    headers = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
        'Access-Control-Allow-Methods': 'GET,OPTIONS,POST'
    }

    try:
        # Parse request body
        body = {}
        if event.get('body'):
            if event.get('isBase64Encoded'):
                body = json.loads(base64.b64decode(event['body']).decode('utf-8'))
            else:
                body = json.loads(event['body'])

        # Generate unique job ID
        job_id = str(uuid.uuid4())
        timestamp = datetime.utcnow().isoformat() + 'Z'

        # Check if requesting presigned URL or direct upload
        request_type = body.get('type', 'presigned')
        filename = body.get('filename', f'{job_id}.mp4')
        content_type = body.get('content_type', 'video/mp4')
        push_token = body.get('push_token')
        user_context = body.get('user_context')  # questionnaire data from frontend
        print(f'[PushNotif] request_type={request_type} — push token present in request: {bool(push_token)}')
        if user_context:
            print(f'[upload_handler] user_context received: {json.dumps(user_context)}')

        # S3 key for video
        s3_key = f'uploads/{job_id}/{filename}'

        if request_type == 'presigned':
            # Generate presigned URL for direct S3 upload
            # Include SSE parameters for KMS-encrypted bucket
            presigned_url = s3.generate_presigned_url(
                'put_object',
                Params={
                    'Bucket': S3_VIDEOS_BUCKET,
                    'Key': s3_key,
                    'ContentType': content_type,
                    'ServerSideEncryption': 'aws:kms'
                },
                ExpiresIn=3600  # 1 hour
            )

            # Create job record in DynamoDB
            print(f'[PushNotif] Saving push token to DynamoDB for job {job_id}: {bool(push_token)}')
            table = dynamodb.Table(DYNAMODB_JOBS_TABLE)
            table.put_item(Item={
                'job_id': job_id,
                'status': 'pending_upload',
                'created_at': timestamp,
                'updated_at': timestamp,
                's3_key': s3_key,
                'filename': filename,
                'push_token': push_token
            })

            return {
                'statusCode': 200,
                'headers': headers,
                'body': json.dumps({
                    'job_id': job_id,
                    'upload_url': presigned_url,
                    'status': 'pending_upload',
                    'message': 'Upload video to the provided URL, then call /api/process/{job_id}'
                })
            }

        elif request_type == 'base64':
            # Handle base64 encoded video (for smaller files)
            video_data = body.get('video_data')
            if not video_data:
                return {
                    'statusCode': 400,
                    'headers': headers,
                    'body': json.dumps({'error': 'video_data is required for base64 upload'})
                }

            # Decode and upload to S3
            video_bytes = base64.b64decode(video_data)
            s3.put_object(
                Bucket=S3_VIDEOS_BUCKET,
                Key=s3_key,
                Body=video_bytes,
                ContentType=content_type
            )

            # Create job record
            table = dynamodb.Table(DYNAMODB_JOBS_TABLE)
            table.put_item(Item={
                'job_id': job_id,
                'status': 'queued',
                'created_at': timestamp,
                'updated_at': timestamp,
                's3_key': s3_key,
                'filename': filename,
                'push_token': push_token
            })

            # Queue for processing
            sqs.send_message(
                QueueUrl=SQS_VIDEO_QUEUE_URL,
                MessageBody=json.dumps({
                    'job_id': job_id,
                    's3_bucket': S3_VIDEOS_BUCKET,
                    's3_key': s3_key,
                    'push_token': push_token
                })
            )

            return {
                'statusCode': 200,
                'headers': headers,
                'body': json.dumps({
                    'job_id': job_id,
                    'status': 'queued',
                    'message': 'Video uploaded and queued for processing'
                })
            }

        elif request_type == 'confirm':
            # Confirm upload complete and start processing
            confirm_job_id = body.get('job_id')
            if not confirm_job_id:
                return {
                    'statusCode': 400,
                    'headers': headers,
                    'body': json.dumps({'error': 'job_id is required to confirm upload'})
                }

            # Get job record
            table = dynamodb.Table(DYNAMODB_JOBS_TABLE)
            response = table.get_item(Key={'job_id': confirm_job_id})

            if 'Item' not in response:
                return {
                    'statusCode': 404,
                    'headers': headers,
                    'body': json.dumps({'error': 'Job not found'})
                }

            job = response['Item']

            # Update push token and user_context if provided by client
            update_expr = 'SET updated_at = :updated_at'
            update_vals = {':updated_at': datetime.utcnow().isoformat() + 'Z'}
            update_names = {}
            if push_token:
                update_expr += ', push_token = :push_token'
                update_vals[':push_token'] = push_token
                job['push_token'] = push_token
            if user_context:
                update_expr += ', user_context = :user_context'
                update_vals[':user_context'] = json.dumps(user_context)
                job['user_context'] = user_context
            table.update_item(
                Key={'job_id': confirm_job_id},
                UpdateExpression=update_expr,
                ExpressionAttributeValues=update_vals,
                **(({'ExpressionAttributeNames': update_names}) if update_names else {})
            )

            # Update status and queue for processing
            table.update_item(
                Key={'job_id': confirm_job_id},
                UpdateExpression='SET #status = :status, updated_at = :updated_at',
                ExpressionAttributeNames={'#status': 'status'},
                ExpressionAttributeValues={
                    ':status': 'queued',
                    ':updated_at': datetime.utcnow().isoformat() + 'Z'
                }
            )

            # Queue for processing — include user_context so the worker/Gemini can use it
            token_for_sqs = job.get('push_token')
            ctx_for_sqs = job.get('user_context')
            print(f'[PushNotif] Queuing job {confirm_job_id} to SQS — push token present: {bool(token_for_sqs)}')
            sqs_body = {
                'job_id': confirm_job_id,
                's3_bucket': S3_VIDEOS_BUCKET,
                's3_key': job['s3_key'],
                'push_token': token_for_sqs,
            }
            if ctx_for_sqs:
                sqs_body['user_context'] = ctx_for_sqs
            sqs.send_message(
                QueueUrl=SQS_VIDEO_QUEUE_URL,
                MessageBody=json.dumps(sqs_body)
            )

            return {
                'statusCode': 200,
                'headers': headers,
                'body': json.dumps({
                    'job_id': confirm_job_id,
                    'status': 'queued',
                    'message': 'Video queued for processing'
                })
            }

        elif request_type == 'user_data_write':
            user_key = body.get('userKey', '').strip()
            data_type = body.get('dataType', '').strip()
            data = body.get('data')
            if not user_key or data_type not in ('profile', 'history') or data is None:
                return {'statusCode': 400, 'headers': headers, 'body': json.dumps({'error': 'invalid params'})}
            udata_key = f'userdata/{user_key}/{data_type}.json'
            s3.put_object(
                Bucket=S3_VIDEOS_BUCKET,
                Key=udata_key,
                Body=json.dumps(data, ensure_ascii=False),
                ContentType='application/json'
            )
            return {'statusCode': 200, 'headers': headers, 'body': json.dumps({'ok': True})}

        elif request_type == 'user_data_read':
            user_key = body.get('userKey', '').strip()
            data_type = body.get('dataType', '').strip()
            if not user_key or data_type not in ('profile', 'history'):
                return {'statusCode': 400, 'headers': headers, 'body': json.dumps({'error': 'invalid params'})}
            udata_key = f'userdata/{user_key}/{data_type}.json'
            try:
                obj = s3.get_object(Bucket=S3_VIDEOS_BUCKET, Key=udata_key)
                data = json.loads(obj['Body'].read().decode('utf-8'))
                return {'statusCode': 200, 'headers': headers, 'body': json.dumps({'data': data})}
            except s3.exceptions.NoSuchKey:
                return {'statusCode': 404, 'headers': headers, 'body': json.dumps({'error': 'not found'})}

        elif request_type == 'user_image_get_url':
            job_id_param = body.get('jobId', '').strip()
            if not job_id_param:
                return {'statusCode': 400, 'headers': headers, 'body': json.dumps({'error': 'invalid params'})}
            table = dynamodb.Table(DYNAMODB_JOBS_TABLE)
            response = table.get_item(Key={'job_id': job_id_param})
            if 'Item' not in response:
                return {'statusCode': 404, 'headers': headers, 'body': json.dumps({'error': 'job not found'})}
            s3_key = response['Item'].get('s3_key')
            if not s3_key:
                return {'statusCode': 404, 'headers': headers, 'body': json.dumps({'error': 'no s3 key for job'})}
            get_url = s3.generate_presigned_url(
                'get_object',
                Params={'Bucket': S3_VIDEOS_BUCKET, 'Key': s3_key},
                ExpiresIn=86400
            )
            return {'statusCode': 200, 'headers': headers, 'body': json.dumps({'url': get_url})}

        elif request_type == 'confirm_gemini':
            # Confirm upload complete and process directly with Gemini (no SQS / ECS pipeline)
            confirm_job_id = body.get('job_id')
            if not confirm_job_id:
                return {
                    'statusCode': 400,
                    'headers': headers,
                    'body': json.dumps({'error': 'job_id is required to confirm upload'})
                }

            # Get job record
            table = dynamodb.Table(DYNAMODB_JOBS_TABLE)
            response = table.get_item(Key={'job_id': confirm_job_id})

            if 'Item' not in response:
                return {
                    'statusCode': 404,
                    'headers': headers,
                    'body': json.dumps({'error': 'Job not found'})
                }

            job = response['Item']

            # Update push token and user_context if provided by client
            cg_update_expr = 'SET updated_at = :updated_at'
            cg_update_vals = {':updated_at': datetime.utcnow().isoformat() + 'Z'}
            if push_token:
                cg_update_expr += ', push_token = :push_token'
                cg_update_vals[':push_token'] = push_token
                job['push_token'] = push_token
            if user_context:
                cg_update_expr += ', user_context = :user_context'
                cg_update_vals[':user_context'] = json.dumps(user_context)
                job['user_context'] = user_context
            table.update_item(
                Key={'job_id': confirm_job_id},
                UpdateExpression=cg_update_expr,
                ExpressionAttributeValues=cg_update_vals,
            )

            # Mark as queued
            table.update_item(
                Key={'job_id': confirm_job_id},
                UpdateExpression='SET #status = :status, updated_at = :updated_at',
                ExpressionAttributeNames={'#status': 'status'},
                ExpressionAttributeValues={
                    ':status': 'queued',
                    ':updated_at': datetime.utcnow().isoformat() + 'Z'
                }
            )

            # Invoke gemini_processor Lambda asynchronously (fire-and-forget)
            # The Lambda updates DynamoDB when done; frontend polls /api/status/{job_id}
            token_for_lambda = job.get('push_token')
            ctx_for_lambda = job.get('user_context')
            print(f'[PushNotif] Invoking gemini_processor for job {confirm_job_id} — push token present: {bool(token_for_lambda)}')
            payload = {
                'job_id':    confirm_job_id,
                's3_bucket': S3_VIDEOS_BUCKET,
                's3_key':    job['s3_key'],
                'push_token': token_for_lambda,
            }
            if ctx_for_lambda:
                payload['user_context'] = ctx_for_lambda
            lambda_client.invoke(
                FunctionName=GEMINI_PROCESSOR_LAMBDA,
                InvocationType='Event',  # async — returns immediately
                Payload=json.dumps(payload),
            )

            return {
                'statusCode': 200,
                'headers': headers,
                'body': json.dumps({
                    'job_id': confirm_job_id,
                    'status': 'queued',
                    'message': 'Media queued for Gemini analysis'
                })
            }

        else:
            return {
                'statusCode': 400,
                'headers': headers,
                'body': json.dumps({'error': f'Unknown request type: {request_type}'})
            }

    except Exception as e:
        print(f"Error: {str(e)}")
        return {
            'statusCode': 500,
            'headers': headers,
            'body': json.dumps({'error': str(e)})
        }
