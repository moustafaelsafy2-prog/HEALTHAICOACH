from google.cloud import vision
import os

os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = r"C:\secure\gcloud-key.json"

client = vision.ImageAnnotatorClient()

with open("test.jpg", "rb") as image_file:
    content = image_file.read()

image = vision.Image(content=content)
response = client.text_detection(image=image)

texts = response.text_annotations

if texts:
    print("النص المستخرج:\n")
    print(texts[0].description)
else:
    print("لم يتم التعرف على نص")
