#!/usr/bin/env python3
"""
Local test script for worker.py - processes a test image without AWS dependencies
This script is designed to run inside the Docker container where all dependencies are available.
"""
import os
import sys
import json
from pathlib import Path

# Set up minimal environment variables (mock AWS services)
os.environ['S3_VIDEOS_BUCKET'] = os.environ.get('S3_VIDEOS_BUCKET', 'mock-bucket')
os.environ['S3_RESULTS_BUCKET'] = os.environ.get('S3_RESULTS_BUCKET', 'mock-results-bucket')
os.environ['S3_MODELS_BUCKET'] = os.environ.get('S3_MODELS_BUCKET', 'mock-models-bucket')
os.environ['DYNAMODB_JOBS_TABLE'] = os.environ.get('DYNAMODB_JOBS_TABLE', 'mock-jobs-table')
os.environ['SQS_VIDEO_QUEUE_URL'] = os.environ.get('SQS_VIDEO_QUEUE_URL', 'mock-queue-url')
os.environ['DEVICE'] = os.environ.get('DEVICE', 'cpu')
os.environ['GEMINI_API_KEY'] = os.environ.get('GEMINI_API_KEY', '')
os.environ['MAX_FRAMES'] = '60'
os.environ['FRAME_SKIP'] = '10'
os.environ['DETECTION_INTERVAL'] = '30'

# Add current directory to path so we can import worker
sys.path.insert(0, '/app')

# Mock AWS services functions
def mock_update_job_status(job_id: str, status: str, **kwargs):
    """Mock DynamoDB update - just print status"""
    print(f"📊 [Mock DynamoDB] Job {job_id}: {status}")
    if kwargs:
        print(f"   Additional data: {kwargs}")

def mock_upload_results(job_id: str, results: dict):
    """Mock S3 upload - save to local file instead"""
    output_dir = Path('/app/test_results')
    output_dir.mkdir(exist_ok=True)
    
    results_file = output_dir / f'{job_id}_results.json'
    with open(results_file, 'w') as f:
        json.dump(results, f, indent=2, default=str)
    
    print(f"💾 [Mock S3] Results saved to: {results_file}")
    return f'results/{job_id}/results.json'

# Mock boto3 clients before importing worker
class MockS3:
    def download_file(self, bucket, key, local_path):
        print(f"📥 [Mock S3] Would download s3://{bucket}/{key} to {local_path}")
    
    def put_object(self, **kwargs):
        print(f"📤 [Mock S3] Would upload to s3://{kwargs.get('Bucket')}/{kwargs.get('Key')}")

class MockSQS:
    def receive_message(self, **kwargs):
        return {'Messages': []}
    
    def delete_message(self, **kwargs):
        pass

class MockDynamoDB:
    class Table:
        def __init__(self, name):
            self.name = name
        
        def update_item(self, **kwargs):
            pass

# Mock boto3 module
class MockBoto3:
    def client(self, service, **kwargs):
        if service == 's3':
            return MockS3()
        elif service == 'sqs':
            return MockSQS()
        return None
    
    def resource(self, service, **kwargs):
        if service == 'dynamodb':
            return MockDynamoDB()
        return None

# Replace boto3 module
import sys
sys.modules['boto3'] = MockBoto3()

# Now import worker (it will use our mocked boto3)
import worker

# Replace AWS-dependent functions with mocks
worker.update_job_status = mock_update_job_status
worker.upload_results = mock_upload_results

# Skip S3 model downloads - we're running locally with local checkpoints
worker.download_models_from_s3 = lambda: print("⏭️  Skipping S3 model downloads (running locally)")

def test_worker_with_image(image_path: str, user_context: dict = None):
    """Test worker.py with a local image file"""

    if not os.path.exists(image_path):
        print(f"❌ Error: Image file not found: {image_path}")
        return None

    print(f"\n{'='*60}")
    print(f"🧪 Testing worker.py with image: {image_path}")
    print(f"{'='*60}\n")

    # Generate a test job ID
    import uuid
    job_id = f"test-{uuid.uuid4().hex[:8]}"

    print(f"📝 Job ID: {job_id}")
    print(f"🖼️  Image: {image_path}")
    print(f"💻 Device: {os.environ.get('DEVICE', 'cpu')}")
    if user_context:
        print(f"📋 user_context: {json.dumps(user_context, indent=2)}")
    print()

    try:
        # Call the process_media function directly
        print("🚀 Starting processing...")
        print("   (This may take a few minutes as models load...)")
        print()

        results = worker.process_media(image_path, job_id, user_context=user_context)
        
        print(f"\n{'='*60}")
        print("✅ Processing completed successfully!")
        print(f"{'='*60}\n")
        
        # Print summary
        print("📊 Results Summary:")
        print(f"  Job ID: {results.get('job_id')}")
        print(f"  Media Type: {results.get('media_type')}")
        print(f"  Detected Items: {len(results.get('detected_items', []))}")
        
        if results.get('detected_items'):
            print("\n  Detected Food Items:")
            for i, item in enumerate(results.get('detected_items', []), 1):
                name = item.get('name', 'Unknown')
                calories = item.get('calories', 'N/A')
                volume = item.get('volume_ml', 'N/A')
                print(f"    {i}. {name}")
                print(f"       Calories: {calories}")
                if volume != 'N/A':
                    print(f"       Volume: {volume} ml")
        
        meal_summary = results.get('meal_summary', {})
        if meal_summary:
            print("\n  Meal Summary:")
            total_calories = meal_summary.get('total_calories', 'N/A')
            total_volume = meal_summary.get('total_volume_ml', 'N/A')
            print(f"    Total Calories: {total_calories}")
            if total_volume != 'N/A':
                print(f"    Total Volume: {total_volume} ml")
        
        # Save full results
        mock_upload_results(job_id, results)
        
        return results
        
    except Exception as e:
        print(f"\n❌ Error during processing: {str(e)}")
        import traceback
        traceback.print_exc()
        return None

if __name__ == '__main__':
    # Get image path from command line
    if len(sys.argv) < 2:
        print("❌ Error: No image path provided")
        print("\nUsage:")
        print(f"  python {sys.argv[0]} <path_to_image> [user_context_json]")
        print("\nExample with user_context:")
        print(f"  python {sys.argv[0]} /app/food.jpg '{{\"hidden_ingredients\":[{{\"name\":\"butter\",\"quantity\":\"10g\"}}],\"extras\":[{{\"name\":\"olive oil\",\"quantity\":\"1 tbsp\"}}],\"recipe_description\":\"grilled chicken salad\"}}'")
        sys.exit(1)

    image_path = sys.argv[1]

    # Optional user_context as second argument (JSON string)
    user_context = None
    if len(sys.argv) >= 3:
        try:
            user_context = json.loads(sys.argv[2])
            print(f"📋 Parsed user_context from args: {json.dumps(user_context, indent=2)}")
        except json.JSONDecodeError as e:
            print(f"❌ Error: Could not parse user_context JSON: {e}")
            sys.exit(1)

    # Run the test
    results = test_worker_with_image(image_path, user_context=user_context)
    
    if results:
        print("\n✅ Test completed successfully!")
        sys.exit(0)
    else:
        print("\n❌ Test failed!")
        sys.exit(1)
