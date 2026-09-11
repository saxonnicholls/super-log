# Windows CI fixture: compile the SDK headers straight from the checkout with
# MSVC, so a green run proves the Winsock port of the transports - the released
# vcpkg port still points at v0.4.0 (pre-Winsock), so we test the working tree,
# not the release. ts-moveables comes from the vcpkg overlay port.
#
# Both build modes are built: DEVELOPMENT (the real wire) and PRODUCTION (the
# inert shell) - both must compile on MSVC. The _development exes are then run
# against a Node mock hub in CI to prove the Winsock transport actually sends.
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

find_package(ts_moveables CONFIG REQUIRED)

# One C and one C++ executable per build mode.
foreach(mode DEVELOPMENT PRODUCTION)
    string(TOLOWER ${mode} m)

    add_executable(csdk_${m} csdk.c)
    target_include_directories(csdk_${m} PRIVATE "${SUPERLOG_ROOT}/sdk/c")
    target_compile_definitions(csdk_${m} PRIVATE SUPERLOG_${mode})

    add_executable(cppsdk_${m} cppsdk.cpp)
    target_include_directories(cppsdk_${m} PRIVATE "${SUPERLOG_ROOT}/sdk/cpp/include")
    target_compile_definitions(cppsdk_${m} PRIVATE SUPERLOG_${mode})
    target_link_libraries(cppsdk_${m} PRIVATE snicholls::ts_moveables)

    if(WIN32)
        # The transports use Winsock; MSVC also auto-links it via a pragma, but
        # be explicit here too (and for the C exe, whose pragma covers MSVC).
        target_link_libraries(csdk_${m} PRIVATE ws2_32)
        target_link_libraries(cppsdk_${m} PRIVATE ws2_32)
    endif()
endforeach()
