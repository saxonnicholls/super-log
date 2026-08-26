# super-log - one hub for every log stream on the dev bench
#
# Builds superlogd (the hub), a compile check for the header-only C++ SDK,
# and optionally the Dear ImGui viewer. The JS/Rust pieces have their own
# toolchains (npm workspaces at the repo root, cargo in sdk/rust).

cmake_minimum_required(VERSION 3.16)

project(super_log
    VERSION 0.1.0
    DESCRIPTION "One hub for every log stream on the dev bench"
    LANGUAGES CXX)

# ts-moveables: a sibling checkout by default, GitHub when there is none.
# The fallback tag is a cache variable so CI can pin a SHA and bump it
# deliberately - green should never depend on another repo's HEAD moving.
set(TS_MOVEABLES_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../TSMoveables"
    CACHE PATH "Local ts-moveables checkout")
set(TS_MOVEABLES_GIT_TAG "main"
    CACHE STRING "ts-moveables tag/SHA for the FetchContent fallback")

set(TS_MOVEABLES_BUILD_TESTS OFF CACHE BOOL "" FORCE)
if(EXISTS "${TS_MOVEABLES_DIR}/CMakeLists.txt")
    add_subdirectory("${TS_MOVEABLES_DIR}" ts_moveables)
else()
    include(FetchContent)
    FetchContent_Declare(ts_moveables
        GIT_REPOSITORY https://github.com/saxonnicholls/ts-moveables.git
        GIT_TAG ${TS_MOVEABLES_GIT_TAG})
    FetchContent_MakeAvailable(ts_moveables)
endif()

# Vendored spdlog + fmt, pinned together in third_party/ (submodules) because
# they break apart: this machine's /usr/local carries spdlog 1.15 beside
# fmt 7, a pair whose headers cannot compile together, and __has_include
# cannot tell broken from present. spdlog v1.15.3 + fmt 11.2.0 is a
# known-good pairing (1.15.x bundles fmt 11.1.x; 11.2.0 is the same major).
# SPDLOG_FMT_EXTERNAL so there is exactly one fmt in the build, ours.
# Explicit -I paths beat the compiler's default /usr/local/include search,
# so the vendored headers win wherever these targets are linked.
set(SUPER_LOG_THIRD_PARTY "${CMAKE_CURRENT_SOURCE_DIR}/third_party")
set(SUPER_LOG_HAS_VENDORED_SPDLOG OFF)
if(EXISTS "${SUPER_LOG_THIRD_PARTY}/fmt/CMakeLists.txt"
   AND EXISTS "${SUPER_LOG_THIRD_PARTY}/spdlog/CMakeLists.txt")
    set(SPDLOG_FMT_EXTERNAL ON CACHE BOOL "" FORCE)
    add_subdirectory("${SUPER_LOG_THIRD_PARTY}/fmt" fmt EXCLUDE_FROM_ALL)
    add_subdirectory("${SUPER_LOG_THIRD_PARTY}/spdlog" spdlog EXCLUDE_FROM_ALL)
    set(SUPER_LOG_HAS_VENDORED_SPDLOG ON)
endif()

# nlohmann/json (submodule, pinned v3.12.0): the readers' JSON. Writers keep
# their hand-rolled serialisers - strict, tiny, dependency-free - but parsing
# is where a real reader earns its keep; the ImGui viewer is the consumer.
set(SUPER_LOG_HAS_NLOHMANN OFF)
if(EXISTS "${SUPER_LOG_THIRD_PARTY}/json/CMakeLists.txt")
    set(JSON_BuildTests OFF CACHE BOOL "" FORCE)
    add_subdirectory("${SUPER_LOG_THIRD_PARTY}/json" json EXCLUDE_FROM_ALL)
    set(SUPER_LOG_HAS_NLOHMANN ON)
endif()

add_subdirectory(hub)

# The C++ SDK is header-only; the target exists so consumers link one name.
add_library(super_log_cpp INTERFACE)
add_library(superlog::cpp ALIAS super_log_cpp)
target_include_directories(super_log_cpp INTERFACE
    $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/sdk/cpp/include>)
target_link_libraries(super_log_cpp INTERFACE snicholls::ts_moveables)

# Every consumer of the SDK declares a build mode - the headers refuse to
# compile without one (sdk/cpp/include/super_log/mode.hpp: exactly one of
# DEVELOPMENT / PRODUCTION, never neither, never both). This cache variable
# supplies the define for the in-repo consumers only; the superlog::cpp
# target deliberately carries no default, because deciding is the point.
set(SUPER_LOG_MODE "DEVELOPMENT" CACHE STRING
    "Build mode for the in-repo SDK consumers: DEVELOPMENT or PRODUCTION")
if(NOT SUPER_LOG_MODE STREQUAL "DEVELOPMENT" AND NOT SUPER_LOG_MODE STREQUAL "PRODUCTION")
    message(FATAL_ERROR "SUPER_LOG_MODE must be DEVELOPMENT or PRODUCTION, got '${SUPER_LOG_MODE}'")
endif()

# Per-mode forwarding policies (mode.hpp): the minimum level each mode ships,
# or OFF. Defaults - development everything, production nothing - and the
# header #errors on an unknown name, so a typo cannot mean "everything".
set(SUPER_LOG_DEV_POLICY "TRACE" CACHE STRING
    "Minimum level forwarded in DEVELOPMENT (TRACE..CRITICAL, or OFF)")
set(SUPER_LOG_PROD_POLICY "OFF" CACHE STRING
    "Minimum level forwarded in PRODUCTION (TRACE..CRITICAL, or OFF)")
set(SUPER_LOG_MODE_DEFINES
    SUPERLOG_${SUPER_LOG_MODE}
    SUPERLOG_DEV_POLICY=${SUPER_LOG_DEV_POLICY}
    SUPERLOG_PROD_POLICY=${SUPER_LOG_PROD_POLICY})

# Headers that only compile in the app that includes them are not a library
# yet - this keeps them honest on every build.
add_executable(super_log_compile_test sdk/cpp/test/compile_test.cpp)
target_link_libraries(super_log_compile_test PRIVATE superlog::cpp)
target_compile_definitions(super_log_compile_test PRIVATE ${SUPER_LOG_MODE_DEFINES})
target_compile_options(super_log_compile_test PRIVATE -Wall -Wextra)

# Defaults ON when the vendored pair is present - that is the whole point of
# vendoring it. OFF elsewhere, so a checkout without submodules still builds.
option(SUPER_LOG_TEST_SPDLOG
    "Compile the spdlog sink in the SDK compile test" ${SUPER_LOG_HAS_VENDORED_SPDLOG})
if(SUPER_LOG_TEST_SPDLOG)
    target_compile_definitions(super_log_compile_test PRIVATE SUPERLOG_TEST_SPDLOG)
    target_link_libraries(super_log_compile_test PRIVATE spdlog::spdlog)
endif()

if(SUPER_LOG_HAS_VENDORED_SPDLOG)
    add_subdirectory(demo/cpp)
endif()

# The CUDA demo, only when a CUDA compiler exists. check_language is the
# supported way to ask without failing configure on the overwhelming majority
# of machines that have no nvcc - enable_language(CUDA) unconditionally would
# make this repo unbuildable for everyone without an NVIDIA toolkit, which is
# a poor trade for one optional demo.
include(CheckLanguage)
check_language(CUDA)
if(CMAKE_CUDA_COMPILER)
    enable_language(CUDA)
    message(STATUS "super-log: CUDA found (${CMAKE_CUDA_COMPILER}) - building demo/cuda")
    add_subdirectory(demo/cuda)
else()
    message(STATUS "super-log: no CUDA compiler - skipping demo/cuda")
endif()

# Vendored imgui + glfw (submodules) when present; FetchContent otherwise.
set(SUPER_LOG_HAS_VENDORED_IMGUI OFF)
if(EXISTS "${SUPER_LOG_THIRD_PARTY}/imgui/imgui.cpp"
   AND EXISTS "${SUPER_LOG_THIRD_PARTY}/glfw/CMakeLists.txt")
    set(SUPER_LOG_HAS_VENDORED_IMGUI ON)
endif()
option(SUPER_LOG_BUILD_IMGUI_VIEWER
    "Build the Dear ImGui viewer" ${SUPER_LOG_HAS_VENDORED_IMGUI})
if(SUPER_LOG_BUILD_IMGUI_VIEWER)
    add_subdirectory(viewer/imgui)
endif()
