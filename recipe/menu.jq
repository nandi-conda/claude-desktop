# menuinst v2 shortcut definition, filled in by build.sh from the .deb's .desktop file.
{
  "$schema": "https://json-schema.org/draft-07/schema",
  "$id": "https://schemas.conda.io/menuinst-1.schema.json",
  "menu_name": $name,
  "menu_items": [
    {
      "name": $name,
      "description": (if $desc == "" then "Claude desktop app" else $desc end),
      "command": ["{{ PREFIX }}/bin/claude-desktop", "%U"],
      "icon": "{{ MENU_DIR }}/claude-desktop.png",
      "activate": false,
      "terminal": false,
      "platforms": {
        "linux": ({
          "Categories": (if $categories == [] then ["Network", "Chat"] else $categories end),
          "MimeType": $mime
        } + (if $wmclass == "" then {} else {"StartupWMClass": $wmclass} end))
      }
    }
  ]
}
