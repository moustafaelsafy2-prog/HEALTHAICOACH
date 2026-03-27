from google.cloud import vision
import os

os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = r"C:\secure\gcloud-key.json"

client = vision.ImageAnnotatorClient()

with open(r"C:\Users\moust\test\test.jpg", "rb") as image_file:
    content = image_file.read()

image = vision.Image(content=content)
response = client.text_detection(image=image)

if response.error.message:
    print("API Error:", response.error.message)
else:
    texts = response.text_annotations
    if texts:
        print(texts[0].description)
    else:
        print("لم يتم التعرف على نص")
