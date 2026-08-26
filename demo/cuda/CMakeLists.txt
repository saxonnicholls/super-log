# The CUDA demo client: a kernel per tick, timed with CUDA events, on the
# bench beside every other stream. Only in the build when a CUDA compiler is
# actually present - see the guard in the root CMakeLists.
#
# Written against the CUDA runtime API but NEVER COMPILED OR RUN: the machine
# this was written on has no NVIDIA GPU and no nvcc. Treat the first build as
# a bring-up.
add_executable(superlog_clock_cuda clock.cu)
target_link_libraries(superlog_clock_cuda PRIVATE superlog::cpp)
target_compile_definitions(superlog_clock_cuda PRIVATE ${SUPER_LOG_MODE_DEFINES})

# Device-side printf needs a real architecture; "native" asks nvcc to build
# for whatever card is in the machine doing the building, which is the right
# default for a demo and wrong for a redistributable binary.
if(NOT DEFINED CMAKE_CUDA_ARCHITECTURES)
    set_property(TARGET superlog_clock_cuda PROPERTY CUDA_ARCHITECTURES native)
endif()

# The SDK headers are ordinary C++; only clock.cu is device code. Separable
# compilation is off on purpose - there is one translation unit and enabling
# it would add a device-link step for no benefit.
# C++17 explicitly: the host code uses if-with-initialiser, and nvcc does not
# inherit CXX_STANDARD from the linked target. Getting this wrong produces a
# wall of syntax errors that look like the source is broken rather than the
# standard being wrong, on a machine where nobody wants to be debugging it.
set_target_properties(superlog_clock_cuda PROPERTIES
    CUDA_SEPARABLE_COMPILATION OFF
    CUDA_STANDARD 17
    CUDA_STANDARD_REQUIRED ON)
