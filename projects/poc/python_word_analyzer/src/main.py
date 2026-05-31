import argparse

from docx import Document

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--file", type=str, required=True)
    args = parser.parse_args()
    file_path = args.file

    doc = Document(file_path)
    for para in doc.paragraphs:
        print(para.text)
