{
  "targets": [
    {
      "target_name": "domino_vcam",
      "sources": [
        "addon/addon.cpp",
        "addon/FrameChannel.cpp",
        "addon/VirtualCamera.cpp"
      ],
      "include_dirs": [
        # Forward slashes deliberately: gyp strips backslashes out of this
        # substitution, which silently produced "..\..node_modulesnode-addon-api"
        # and a missing napi.h.
        "<!@(node -p \"require('node-addon-api').include_dir.split(require('path').sep).join('/')\")",
        "shared"
      ],
      # N-API only: no direct V8 use, so one build works across Node and
      # Electron versions without rebuilding per ABI.
      "defines": [
        "NAPI_DISABLE_CPP_EXCEPTIONS",
        "NOMINMAX",
        "WIN32_LEAN_AND_MEAN",
        "UNICODE",
        "_UNICODE"
      ],
      "conditions": [
        [
          "OS=='win'",
          {
            "libraries": [
              "-lmfsensorgroup.lib",
              "-lmfplat.lib",
              "-lmfuuid.lib",
              "-lole32.lib",
              "-loleaut32.lib",
              "-ladvapi32.lib"
            ],
            "msvs_settings": {
              "VCCLCompilerTool": {
                "ExceptionHandling": 1,
                "AdditionalOptions": ["/std:c++17"]
              }
            }
          }
        ]
      ]
    }
  ]
}
