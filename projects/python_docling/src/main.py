import argparse

from docling.document_converter import DocumentConverter


def main(file_path: str):
    converter = DocumentConverter()
    result = converter.convert(file_path)
    print(result.document.export_to_markdown())


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--file", type=str, required=True)
    args = parser.parse_args()
    file_path = args.file

    main(file_path)
