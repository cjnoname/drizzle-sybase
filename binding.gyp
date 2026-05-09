{
  "targets": [
    {
      "target_name": "sybase_native",
      "sources": ["src/native/binding.c"],
      "include_dirs": [
        "deps/freetds/include"
      ],
      "conditions": [
        ["OS=='linux'", {
          "libraries": [
            "<(module_root_dir)/deps/freetds/lib/libsybdb.a"
          ],
          "ldflags": [
            "-Wl,-rpath,'$$ORIGIN'"
          ]
        }],
        ["OS=='mac'", {
          "libraries": [
            "<(module_root_dir)/deps/freetds/lib/libsybdb.a"
          ],
          "xcode_settings": {
            "OTHER_LDFLAGS": [
              "-L<(module_root_dir)/deps/freetds/lib"
            ]
          }
        }],
        ["OS=='win'", {
          "libraries": [
            "<(module_root_dir)/deps/freetds/lib/db-lib.lib",
            "<(module_root_dir)/deps/freetds/lib/tds.lib",
            "<(module_root_dir)/deps/freetds/lib/replacements.lib",
            "<(module_root_dir)/deps/freetds/lib/tdsutils.lib",
            "ws2_32.lib",
            "crypt32.lib"
          ],
          "msvs_settings": {
            "VCLinkerTool": {
              "AdditionalLibraryDirectories": [
                "<(module_root_dir)/deps/freetds/lib"
              ],
              "AdditionalOptions": [
                "/NODEFAULTLIB:LIBCMT"
              ]
            }
          }
        }]
      ],
      "cflags": ["-Wall", "-Wextra", "-O2"],
      "xcode_settings": {
        "GCC_WARN_ABOUT_MISSING_PROTOTYPES": "YES",
        "CLANG_CXX_LANGUAGE_STANDARD": "c11"
      },
      "msvs_settings": {
        "VCCLCompilerTool": {
          "WarningLevel": "3"
        }
      }
    }
  ]
}
