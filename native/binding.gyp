{
  "targets": [
    {
      "target_name": "domino_vcam",
      "sources": [
        "addon/addon.cpp",
        "addon/CaptureProbe.cpp",
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
              "-lmf.lib",
              "-lmfplat.lib",
              "-lmfreadwrite.lib",
              "-lmfuuid.lib",
              "-lole32.lib",
              "-loleaut32.lib",
              "-ladvapi32.lib",
              "-lshell32.lib"
            ],
            "msvs_settings": {
              "VCCLCompilerTool": {
                "ExceptionHandling": 1,
                # Link-time code generation leaves a stale IPDB behind whenever
                # only part of the target is recompiled, and the next link dies
                # with "debugging information corrupt". Nothing here is hot
                # enough to be worth that.
                "WholeProgramOptimization": "false",
                "AdditionalOptions": ["/std:c++17"]
              },
              "VCLinkerTool": {
                "LinkTimeCodeGeneration": 0
              }
            }
          }
        ]
      ]
    },
    {
      # The media source COM server. This is a plain DLL, not a .node addon:
      # the Windows Frame Server loads it into its own process, where nothing
      # about Node or Electron exists. It shares only the protocol and reader
      # headers with the addon above.
      "target_name": "domino_vcam_source",
      "type": "shared_library",
      "product_extension": "dll",
      "variables": {
        # The delay-load hook exists to let a .node addon find node.exe
        # exports. Linking it into a DLL that Windows loads on its own would
        # make it fail to load at all.
        "win_delay_load_hook": "false"
      },
      "sources": [
        "vcam/dllmain.cpp",
        "vcam/MediaSource.cpp",
        "vcam/MediaStream.cpp"
      ],
      "include_dirs": [
        "shared",
        "vcam"
      ],
      "defines": [
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
              "-lmfplat.lib",
              "-lmfuuid.lib",
              "-lmf.lib",
              "-lole32.lib",
              "-loleaut32.lib",
              "-lksuser.lib",
              "-ladvapi32.lib"
            ],
            "msvs_settings": {
              "VCCLCompilerTool": {
                "ExceptionHandling": 1,
                "WholeProgramOptimization": "false",
                "AdditionalOptions": ["/std:c++17"]
              },
              "VCLinkerTool": {
                "LinkTimeCodeGeneration": 0,
                # Without this the DLL exports nothing and COM cannot create
                # the class, which surfaces only as a camera that will not
                # start.
                "ModuleDefinitionFile":
                    "<(module_root_dir)/vcam/domino_vcam_source.def"
              }
            }
          }
        ]
      ]
    }
  ]
}
