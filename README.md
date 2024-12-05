# monorepo

## Customizing settings.json

To open the user settings in JSON format in Visual Studio Code, follow these steps:

1. **Open Command Palette**: Press `Ctrl + Shift + P` (or `Cmd + Shift + P` on macOS) to open the Command Palette.
  
1. **Search for Settings**: Type `Preferences: Open Settings (JSON)` and select it from the list. This will open the `settings.json` file in the editor, where you can directly edit your user settings in JSON format.

1. **I will add the following content**:

    ```json
    {
      "[python]": {
        "editor.tabSize": 2,
        "editor.defaultFormatter": "ms-python.black-formatter",
        "editor.formatOnSave": true,
        "editor.formatOnType": true,
        "editor.codeActionsOnSave": {
          "source.organizeImports": "always"
        }
      },
      "isort.args": [
        "--profile",
        "black"
      ],
      "dev.containers.defaultExtensions": [
        "ms-python.black-formatter",
        "ms-python.flake8",
        "ms-python.isort",
        "eamodio.gitlens",
        "mhutchie.git-graph",
        "tomoki1207.pdf"
      ],
    }
    ```
