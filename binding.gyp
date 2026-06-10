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
            "VCCLCompilerTool": {
              "WholeProgramOptimization": "false",
              "AdditionalOptions!": [
                "-flto=thin",
                "-flto=full"
              ]
            },
            "VCLibrarianTool": {
              "AdditionalOptions!": [
                "-flto=thin",
                "-flto=full"
              ]
            },
            "VCLinkerTool": {
              "LinkTimeCodeGeneration": "0",
              "AdditionalLibraryDirectories": [
                "<(module_root_dir)/deps/freetds/lib"
              ],
              "AdditionalOptions": [
                "/NODEFAULTLIB:LIBCMT"
              ],
              "AdditionalOptions!": [
                "-flto=thin",
                "-flto=full",
                "/opt:lldltojobs=2",
                "/opt:lldltojobs=1",
                "/opt:lldltojobs=4",
                "/opt:lldltojobs=8"
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
