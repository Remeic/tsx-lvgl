set(REPOSITORY_ROOT "${CMAKE_CURRENT_LIST_DIR}/../../..")
set(GENERATED_DIR "${CMAKE_BINARY_DIR}/tsx-lvgl-generated")
set(GENERATED_C "${GENERATED_DIR}/ui.c")
set(GENERATED_MANIFEST "${GENERATED_DIR}/manifest.json")
file(MAKE_DIRECTORY "${GENERATED_DIR}")

# ESP-IDF first evaluates component files in CMake script mode, where
# CONFIGURE_DEPENDS is forbidden. The real project configure uses it so new
# compiler/emitter/react/core files invalidate the generation command.
if(CMAKE_SCRIPT_MODE_FILE)
  file(GLOB_RECURSE TSX_LVGL_COMPILER_INPUTS
    "${REPOSITORY_ROOT}/packages/compiler/src/*.ts"
    "${REPOSITORY_ROOT}/packages/lvgl-emitter/src/*.ts"
    "${REPOSITORY_ROOT}/packages/react/src/*.ts"
    "${REPOSITORY_ROOT}/packages/core/src/*.ts"
  )
else()
  file(GLOB_RECURSE TSX_LVGL_COMPILER_INPUTS CONFIGURE_DEPENDS
    "${REPOSITORY_ROOT}/packages/compiler/src/*.ts"
    "${REPOSITORY_ROOT}/packages/lvgl-emitter/src/*.ts"
    "${REPOSITORY_ROOT}/packages/react/src/*.ts"
    "${REPOSITORY_ROOT}/packages/core/src/*.ts"
  )
endif()
list(APPEND TSX_LVGL_COMPILER_INPUTS
  "${REPOSITORY_ROOT}/examples/counter.tsx"
  "${REPOSITORY_ROOT}/scripts/compile-entry.mjs"
  "${REPOSITORY_ROOT}/package.json"
  "${REPOSITORY_ROOT}/package-lock.json"
  "${REPOSITORY_ROOT}/tsconfig.json"
  "${REPOSITORY_ROOT}/tsconfig.base.json"
  "${REPOSITORY_ROOT}/tsconfig.tests.json"
  "${REPOSITORY_ROOT}/packages/compiler/package.json"
  "${REPOSITORY_ROOT}/packages/compiler/tsconfig.json"
  "${REPOSITORY_ROOT}/packages/react/package.json"
  "${REPOSITORY_ROOT}/packages/react/tsconfig.json"
  "${REPOSITORY_ROOT}/packages/lvgl-emitter/package.json"
  "${REPOSITORY_ROOT}/packages/lvgl-emitter/tsconfig.json"
  "${REPOSITORY_ROOT}/packages/core/package.json"
  "${REPOSITORY_ROOT}/packages/core/tsconfig.json"
)
if(NOT CMAKE_SCRIPT_MODE_FILE)
  add_custom_command(
    OUTPUT "${GENERATED_C}" "${GENERATED_MANIFEST}"
    COMMAND npm run build
    COMMAND node "${REPOSITORY_ROOT}/scripts/compile-entry.mjs"
            "${REPOSITORY_ROOT}/examples/counter.tsx"
            "${GENERATED_DIR}"
            counter
    DEPENDS ${TSX_LVGL_COMPILER_INPUTS}
    WORKING_DIRECTORY "${REPOSITORY_ROOT}"
    COMMENT "Compiling counter.tsx to the ESP-IDF LVGL artifact"
    VERBATIM
  )
endif()

idf_component_register(
  SRCS "main.c" "${GENERATED_C}"
  INCLUDE_DIRS "." "${GENERATED_DIR}"
  REQUIRES esp32_s3_touch_amoled_1_8
)

set_source_files_properties("${GENERATED_C}" PROPERTIES
  COMPILE_OPTIONS "-Wall;-Wextra;-Werror"
)

if(NOT CMAKE_SCRIPT_MODE_FILE)
  add_custom_target(tsx_lvgl_manifest ALL DEPENDS "${GENERATED_MANIFEST}")
endif()
