idf_component_register(
    SRCS "app_main.c"
    INCLUDE_DIRS "."
    EMBED_TXTFILES "kernel.js" "app.g1.js" "app.g1.manifest.json"
    REQUIRES tsx_runtime_probe tsx_board_adapter_v2
)
