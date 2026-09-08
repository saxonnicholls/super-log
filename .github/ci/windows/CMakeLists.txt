# Windows CI fixture: compile the SDK headers straight from the checkout with
# MSVC, so a green run proves the Winsock port of the transports - the released
# vcpkg port still points at v0.3.0 (pre-Winsock), so we test the working tree,
# not the release. ts-moveables comes from the vcpkg overlay port.
#
#   cmake -S .github/ci/windows -B build -DSUPERLOG_ROOT=<repo> \
#         -DCMAKE_TOOLCHAIN_FILE=<vcpkg>/scripts/buildsystems/vcpkg.cmake \
#         -DVCPKG_TARGET_TRIPLET=x64-windows
cmake_minimum_required(VERSION 3.16)
project(superlog_windows_ci C CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

if(NOT DEFINED SUPERLOG_ROOT)
    message(FATAL_ERROR "pass -DSUPERLOG_ROOT=<repo root>")
endif()

# The C SDK - one header, its own Winsock path.
add_executable(csdk csdk.c)
target_include_directories(csdk PRIVATE "${SUPERLOG_ROOT}/sdk/c")
target_compile_definitions(csdk PRIVATE SUPERLOG_DEVELOPMENT)

# The C++ SDK - header-only, against ts-moveables from vcpkg.
find_package(ts_moveables CONFIG REQUIRED)
add_executable(cppsdk cppsdk.cpp)
target_include_directories(cppsdk PRIVATE "${SUPERLOG_ROOT}/sdk/cpp/include")
target_compile_definitions(cppsdk PRIVATE SUPERLOG_DEVELOPMENT)
target_link_libraries(cppsdk PRIVATE snicholls::ts_moveables)

if(WIN32)
    # The transports use Winsock; MSVC also auto-links it via a pragma, but be
    # explicit here too.
    target_link_libraries(csdk PRIVATE ws2_32)
    target_link_libraries(cppsdk PRIVATE ws2_32)
endif()
