import argparse
import os

from docling.document_converter import DocumentConverter


def document_to_markdown(file_path: str) -> str:
    converter = DocumentConverter()
    result = converter.convert(file_path)
    return result.document.export_to_markdown()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--file", type=str, required=True)
    args = parser.parse_args()
    file_path = args.file

    md = document_to_markdown(file_path)
    export_dir = "dist"
    export_file = f"{export_dir}/export.md"
    os.makedirs(export_dir, exist_ok=True)
    with open(export_file, "w", encoding="utf-8") as f:
        f.write(md)


if __name__ == "__main__":
    main()
