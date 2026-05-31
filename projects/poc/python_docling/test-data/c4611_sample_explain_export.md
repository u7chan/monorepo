<!-- image -->

## PDF BOOKMARK SAMPLE

| Sample Date:                                                         | May 2001                  |
|----------------------------------------------------------------------|---------------------------|
| Accelio Present Applied Technology                                   | Prepared by:              |
| Accelio Present Central 5.4                                          | Created and Tested Using: |
| Primary bookmarks in a PDF file.  Secondary bookmarks in a PDF file. | Features Demonstrated:    |

## Overview

This sample consists of a simple form containing four distinct fields. The data file contains eight separate records.

By default, the data file will produce a PDF file containing eight separate pages. The selective use of the bookmark file will produce the same PDF with a separate pane containing bookmarks. This screenshot of the sample output shows a PDF file with bookmarks.

<!-- image -->

The left pane displays the available bookmarks for this PDF. You may need to enable the display of bookmarks in Adobe  Acrobat  Reader by clicking Window > Show Bookmarks . Selecting a date from the left pane displays the corresponding page within the document.

Note that the index has been sorted according to the specification in the bookmark file, and that pages within the file are created according to the original order in the data file.

<!-- image -->

## Sample Data File

^reformat trunc ^symbolset WINLATIN1 ^field trans\_date 2000-01-1 ^field description Description for item #1 ^field trans\_type TYPE1 ^field trans\_amount 11.00 ^page 1 ^field trans\_date 2000-01-2 ^field description Description for item #2 ^field trans\_type TYPE2 ^field trans\_amount 11.00 ^page 1 ^field trans\_date 2000-01-3 ^field description Description for item #3 ^field trans\_type TYPE3

## Sample Bookmark File

[invoices] Invoices by Date=0 trans\_date=1,A [type] Invoices by Item Type=0 trans\_type=1,A [amount] Invoices by Transaction Amount=0 trans\_amount=1,D

The example bookmark file includes three distinct sections:

- · Invoices sorted, ascending, by date.
- · Invoices sorted, ascending, by item type.
- · Invoices sorted, descending, by transaction amount.

<!-- image -->

## Sample Files

## This sample package contains:

| Filename            | Description                           |
|---------------------|---------------------------------------|
| ap\_bookmark.IFD     | The template design.                  |
| ap\_bookmark.mdf     | The template targeted for PDF output. |
| ap\_bookmark.dat     | A sample data file in DAT format.     |
| ap\_bookmark.bmk     | A sample bookmark file.               |
| ap\_bookmark.pdf     | Sample PDF output.                    |
| ap\_bookmark\_doc.pdf | A document describing the sample.     |

## Deploying the Sample

To deploy this sample in your environment:

- 1. Open the template design ap\_bookmark.IFD in Output Designer and recompile the template for the appropriate presentment target.
- 2. Modify the -z option in the ^job command in the data file ap\_bookmark.dat to:
- · Identify the target output device.
- · Identify the bookmark file using the -abmk command.
- · Identify the section for which to generate bookmarks, if desired, using the -abms command.

## For example,

| To bookmark by GLYPH<133>   | Use the command line parameter GLYPH<133>   |
|-----------------------------|---------------------------------------------|
| Invoices                    | -abmk ap\_bookmark.bmk -abms invoices        |
| Type                        | -abmk ap\_bookmark.bmk -abms type            |
| Amount                      | -abmk ap\_bookmark.bmk -abms amount          |

<!-- image -->

- 3. Place the accompanying files in directories consistent with your implementation:
- · Place ap\_bookmark.IFD in the Designs subdirectory for Output Designer.
- · Place ap\_bookmark.mdf in the forms subdirectory accessible to Central.
- · Place ap\_bookmark.bmk in an addressable directory.

## Running the Sample

- · To run this sample, place ap\_bookmark.dat in the collector directory scanned by Central.
