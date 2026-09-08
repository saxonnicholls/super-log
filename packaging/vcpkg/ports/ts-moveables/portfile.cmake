# vcpkg port for ts-moveables - Saxon Nicholls' header-only C++17 movable
# synchronisation primitives. It already ships proper CMake install/export
# rules (the interface target snicholls::ts_moveables and a
# find_package(ts_moveables) config), so this port is thin: configure,
# install, fix up the config location, done.
#
# Uses the v1.1.1 release tag (official vcpkg wants a versioned release, not a
# raw commit). super-log[cpp]'s headers are verified to compile against it.

vcpkg_from_github(
    OUT_SOURCE_PATH SOURCE_PATH
    REPO saxonnicholls/ts-moveables
    REF "v${VERSION}"
    SHA512 5c6d7a7fbf2ba984bea3d72cf5dfed82f4348b9b2b5dd752fa2f0aa55965bbc2ff52b8a17489edc9889ef7d1e090c27d6463eeb5461483624c8720a38ce640d0
    HEAD_REF main
)

vcpkg_cmake_configure(
    SOURCE_PATH "${SOURCE_PATH}"
    OPTIONS
        -DTS_MOVEABLES_BUILD_TESTS=OFF
)

vcpkg_cmake_install()
vcpkg_cmake_config_fixup(PACKAGE_NAME ts_moveables CONFIG_PATH lib/cmake/ts_moveables)

# Header-only: there is nothing under lib/ or a debug tree to keep.
file(REMOVE_RECURSE
    "${CURRENT_PACKAGES_DIR}/debug"
    "${CURRENT_PACKAGES_DIR}/lib")

vcpkg_install_copyright(FILE_LIST "${SOURCE_PATH}/LICENSE")
