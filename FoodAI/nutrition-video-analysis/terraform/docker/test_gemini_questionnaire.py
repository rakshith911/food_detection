#!/usr/bin/env python3
"""
Standalone test: sends a food image + questionnaire user_context directly to Gemini.
No SAM2, no Florence-2, no Docker needed. Just needs: pip install google-genai
"""
import json
import os
import sys

GEMINI_API_KEY = os.environ.get('GEMINI_API_KEY', '')
if not GEMINI_API_KEY:
    print("ERROR: GEMINI_API_KEY not set. Run: export GEMINI_API_KEY=your_key")
    sys.exit(1)

IMAGE_PATH = sys.argv[1] if len(sys.argv) > 1 else None
if not IMAGE_PATH or not os.path.exists(IMAGE_PATH):
    print(f"ERROR: Provide a valid image path as first argument")
    print(f"Usage: python3 {sys.argv[0]} /path/to/food.jpg")
    sys.exit(1)

USER_CONTEXT = {}
if len(sys.argv) > 2:
    try:
        USER_CONTEXT = json.loads(sys.argv[2])
    except json.JSONDecodeError as e:
        print(f"ERROR: Invalid user_context JSON: {e}")
        sys.exit(1)

BASE_PROMPT = """You are a nutrition expert. Analyze this food image and return a detailed nutritional breakdown.

Return ONLY valid JSON with this exact structure (no markdown, no extra text):
{
  "meal_name": "Name of the overall meal or dish",
  "items": [
    {
      "food_name": "Specific food item name",
      "mass_g": 150,
      "total_calories": 320
    }
  ],
  "nutrition_summary": {
    "total_calories_kcal": 320,
    "total_mass_g": 150,
    "num_food_items": 1,
    "total_food_volume_ml": 150
  }
}

Rules:
- List every distinct food item you can see as a separate entry in "items"
- Use realistic portion weights
- total_calories is the estimated calories for that specific item at its estimated weight
- nutrition_summary totals must match the sum of all items
- Output ONLY the JSON object, nothing else
"""

def build_prompt(user_context):
    prompt = BASE_PROMPT
    if not user_context:
        return prompt

    additions = []
    hidden = user_context.get('hidden_ingredients', [])
    if hidden:
        text = ', '.join(
            f"{i['name']} ({i['quantity']})" if i.get('quantity') else i['name']
            for i in hidden if i.get('name')
        )
        if text:
            additions.append(f"Hidden/not-visible ingredients: {text}. Include these as separate items.")

    extras = user_context.get('extras', [])
    if extras:
        text = ', '.join(
            f"{i['name']} ({i['quantity']})" if i.get('quantity') else i['name']
            for i in extras if i.get('name')
        )
        if text:
            additions.append(f"Extras or cooking additions: {text}. Factor into calorie totals.")

    recipe = user_context.get('recipe_description', '').strip()
    if recipe:
        additions.append(f"Recipe/menu description: \"{recipe}\". Use to improve accuracy.")

    if additions:
        prompt += "\nIMPORTANT ADDITIONAL CONTEXT FROM THE USER:\n"
        for a in additions:
            prompt += f"- {a}\n"

    return prompt

try:
    from google import genai
    from google.genai import types
except ImportError:
    print("ERROR: google-genai not installed. Run: pip install google-genai")
    sys.exit(1)

prompt = build_prompt(USER_CONTEXT)

print(f"\n--- IMAGE: {IMAGE_PATH}")
print(f"--- USER CONTEXT: {json.dumps(USER_CONTEXT, indent=2) if USER_CONTEXT else 'none'}")
print(f"\n--- PROMPT SENT TO GEMINI ---\n{prompt}\n----------------------------\n")

client = genai.Client(api_key=GEMINI_API_KEY)

with open(IMAGE_PATH, 'rb') as f:
    image_bytes = f.read()

ext = os.path.splitext(IMAGE_PATH)[1].lower()
mime = {'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'png': 'image/png', 'webp': 'image/webp'}.get(ext.lstrip('.'), 'image/jpeg')

print("Calling Gemini...")
response = client.models.generate_content(
    model='gemini-2.5-flash',
    contents=types.Content(parts=[
        types.Part(inline_data=types.Blob(data=image_bytes, mime_type=mime)),
        types.Part(text=prompt),
    ])
)

print("\n--- GEMINI RESPONSE ---")
print(response.text)
print("-----------------------")

try:
    import re
    text = re.sub(r'```json\s*', '', response.text)
    text = re.sub(r'```\s*', '', text)
    data = json.loads(text.strip())
    print("\n--- PARSED RESULT ---")
    print(f"Meal: {data.get('meal_name')}")
    for item in data.get('items', []):
        print(f"  {item['food_name']}: {item['mass_g']}g, {item['total_calories']} kcal")
    ns = data.get('nutrition_summary', {})
    print(f"TOTAL: {ns.get('total_calories_kcal')} kcal, {ns.get('total_mass_g')}g")
except Exception as e:
    print(f"Could not parse JSON: {e}")
