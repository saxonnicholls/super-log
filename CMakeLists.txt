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
set(TS_MOVEABLES_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../TSMoveables"
    CACHE PATH "Local ts-moveables checkout")

set(TS_MOVEABLES_BUILD_TESTS OFF CACHE BOOL "" FORCE)
if(EXISTS "${TS_MOVEABLES_DIR}/CMakeLists.txt")
    add_subdirectory("${TS_MOVEABLES_DIR}" ts_moveables)
else()
    include(FetchContent)
    FetchContent_Declare(ts_moveables
        GIT_REPOSITORY https://github.com/saxonnicholls/ts-moveables.git
        GIT_TAG main)
    FetchContent_MakeAvailable(ts_moveables)
endif()

add_subdirectory(hub)

# The C++ SDK is header-only; the target exists so consumers link one name.
add_library(super_log_cpp INTERFACE)
add_library(superlog::cpp ALIAS super_log_cpp)
target_include_directories(super_log_cpp INTERFACE
    $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/sdk/cpp/include>)
target_link_libraries(super_log_cpp INTERFACE snicholls::ts_moveables)

# Headers that only compile in the app that includes them are not a library
# yet - this keeps them honest on every build.
add_executable(super_log_compile_test sdk/cpp/test/compile_test.cpp)
target_link_libraries(super_log_compile_test PRIVATE superlog::cpp)
target_compile_options(super_log_compile_test PRIVATE -Wall -Wextra)

option(SUPER_LOG_TEST_SPDLOG "Compile the spdlog sink in the SDK compile test" OFF)
if(SUPER_LOG_TEST_SPDLOG)
    target_compile_definitions(super_log_compile_test PRIVATE SUPERLOG_TEST_SPDLOG)
endif()

option(SUPER_LOG_BUILD_IMGUI_VIEWER
    "Build the Dear ImGui viewer (FetchContent downloads imgui + glfw)" OFF)
if(SUPER_LOG_BUILD_IMGUI_VIEWER)
    add_subdirectory(viewer/imgui)
endif()
