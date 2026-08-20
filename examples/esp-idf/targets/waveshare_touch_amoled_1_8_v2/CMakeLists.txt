cmake_minimum_required(VERSION 3.16)

# This is a separate composition root. It shares only the target-neutral
# runtime and adapter contract with V1; managed component output and build
# artifacts stay under this target directory.
set(EXTRA_COMPONENT_DIRS "${CMAKE_CURRENT_LIST_DIR}/../../components")
include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(tsx_lvgl_waveshare_v2)
