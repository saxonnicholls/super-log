! Copyright 2026 Saxon Herschel Nicholls
! SPDX-License-Identifier: MIT
!
! The Fortran demo client - the same clock the other demo clients run, one
! line a second on topic fortran.clock, plus the thing a solver actually
! cares about: a residual reported as a metric each step, and a divergence
! that arrives as an ERROR rather than as a wall of NaN in a slurm file
! nobody reads until the run has finished wasting its allocation.
!
!   gfortran -cpp -DDEVELOPMENT ../../sdk/fortran/superlog.F90 clock.f90 -o clock
!   ./clock
!   ./clock --diverge

program clock
  use superlog
  use, intrinsic :: iso_fortran_env, only: real64
  implicit none

  integer :: tick, nargs
  real(real64) :: residual
  character(len=32) :: arg
  logical :: diverge

  diverge = .false.
  nargs = command_argument_count()
  if (nargs >= 1) then
    call get_command_argument(1, arg)
    diverge = (trim(arg) == '--diverge')
  end if

  call sl_init(topic='fortran.clock', app='clock')
  call sl_status()
  call sl_info('fortran clock up - one line a second', 'solver', 'jacobi')

  residual = 1.0_real64
  do tick = 1, 3600
    ! One trace per step, so a step's tick, its residual and any error it
    ! raises read as one story in the viewer rather than three coincidences.
    call sl_set_trace(sl_new_trace())
    call sl_info('tick ' // clock_hms(), 'tick', itoa(tick))

    residual = residual * merge(8.0_real64, 0.72_real64, diverge)
    call sl_metric('solver.residual', residual)

    if (diverge .and. residual > 1.0e6_real64) then
      call sl_error('solver diverged - residual past 1e6', 'tick', itoa(tick))
      call sl_close()
      stop 1
    end if
    if (modulo(tick, 5) == 0) call sl_metric('clock.uptime_s', real(tick, real64))

    call sl_flush()
    call sleep(1)
  end do

  call sl_close()

contains

  function clock_hms() result(s)
    character(len=8) :: s
    integer :: v(8)
    call date_and_time(values=v)
    write (s, '(i2.2,":",i2.2,":",i2.2)') v(5), v(6), v(7)
  end function

  function itoa(n) result(s)
    integer, intent(in) :: n
    character(len=:), allocatable :: s
    character(len=16) :: b
    write (b, '(i0)') n
    s = trim(adjustl(b))
  end function

end program clock
