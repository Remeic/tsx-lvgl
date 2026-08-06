cmake_minimum_required(VERSION 3.20)
project(tsx_lvgl_simulator LANGUAGES C)

include(FetchContent)

set(CONFIG_LV_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(CONFIG_LV_BUILD_DEMOS OFF CACHE BOOL "" FORCE)
set(CONFIG_LV_USE_THORVG_INTERNAL OFF CACHE BOOL "" FORCE)
set(LV_BUILD_CONF_PATH "${CMAKE_CURRENT_LIST_DIR}/lv_conf.h" CACHE FILEPATH "" FORCE)

FetchContent_Declare(
  lvgl
  URL https://github.com/lvgl/lvgl/archive/refs/tags/v9.5.0.tar.gz
  URL_HASH SHA256=34a955cdf3a2d005507b704e87357af669a114523b6d3f77b5344fdc68717bc6
  DOWNLOAD_EXTRACT_TIMESTAMP TRUE
)
FetchContent_MakeAvailable(lvgl)

find_package(SDL2 REQUIRED)
target_link_libraries(lvgl PUBLIC SDL2::SDL2)

set(GENERATED_DIR "${CMAKE_CURRENT_BINARY_DIR}/generated")
set(GENERATED_C "${GENERATED_DIR}/ui.c")
set(GENERATED_MANIFEST "${GENERATED_DIR}/manifest.json")
file(MAKE_DIRECTORY "${GENERATED_DIR}")
file(GLOB_RECURSE TSX_LVGL_COMPILER_INPUTS CONFIGURE_DEPENDS
  "${CMAKE_CURRENT_LIST_DIR}/../../packages/compiler/src/*.ts"
  "${CMAKE_CURRENT_LIST_DIR}/../../packages/lvgl-emitter/src/*.ts"
  "${CMAKE_CURRENT_LIST_DIR}/../../packages/react/src/*.ts"
  "${CMAKE_CURRENT_LIST_DIR}/../../packages/core/src/*.ts"
)
list(APPEND TSX_LVGL_COMPILER_INPUTS
  "${CMAKE_CURRENT_LIST_DIR}/../../examples/counter.tsx"
  "${CMAKE_CURRENT_LIST_DIR}/../../scripts/compile-entry.mjs"
  "${CMAKE_CURRENT_LIST_DIR}/../../package.json"
  "${CMAKE_CURRENT_LIST_DIR}/../../package-lock.json"
  "${CMAKE_CURRENT_LIST_DIR}/../../tsconfig.json"
  "${CMAKE_CURRENT_LIST_DIR}/../../tsconfig.base.json"
  "${CMAKE_CURRENT_LIST_DIR}/../../tsconfig.tests.json"
  "${CMAKE_CURRENT_LIST_DIR}/../../packages/compiler/package.json"
  "${CMAKE_CURRENT_LIST_DIR}/../../packages/compiler/tsconfig.json"
  "${CMAKE_CURRENT_LIST_DIR}/../../packages/react/package.json"
  "${CMAKE_CURRENT_LIST_DIR}/../../packages/react/tsconfig.json"
  "${CMAKE_CURRENT_LIST_DIR}/../../packages/lvgl-emitter/package.json"
  "${CMAKE_CURRENT_LIST_DIR}/../../packages/lvgl-emitter/tsconfig.json"
  "${CMAKE_CURRENT_LIST_DIR}/../../packages/core/package.json"
  "${CMAKE_CURRENT_LIST_DIR}/../../packages/core/tsconfig.json"
)
add_custom_command(
  OUTPUT "${GENERATED_C}" "${GENERATED_MANIFEST}"
  COMMAND npm run build
  COMMAND node "${CMAKE_CURRENT_LIST_DIR}/../../scripts/compile-entry.mjs"
          "${CMAKE_CURRENT_LIST_DIR}/../../examples/counter.tsx"
          "${GENERATED_DIR}"
          counter
  DEPENDS ${TSX_LVGL_COMPILER_INPUTS}
  WORKING_DIRECTORY "${CMAKE_CURRENT_LIST_DIR}/../.."
  COMMENT "Compiling counter.tsx to the simulator LVGL artifact"
  VERBATIM
)

add_executable(tsx_lvgl_simulator
  src/main.c
  "${GENERATED_C}"
)
target_link_libraries(tsx_lvgl_simulator PRIVATE lvgl SDL2::SDL2)
target_compile_features(tsx_lvgl_simulator PRIVATE c_std_11)
target_compile_options(tsx_lvgl_simulator PRIVATE -Wall -Wextra -Werror)
target_include_directories(tsx_lvgl_simulator PRIVATE "${GENERATED_DIR}" "${lvgl_SOURCE_DIR}/src")

add_custom_target(tsx_lvgl_manifest ALL DEPENDS "${GENERATED_MANIFEST}")
