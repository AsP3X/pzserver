<?php

namespace App\Enums;

enum BroadcastCadence: string
{
    case Interval = 'interval';
    case Daily = 'daily';
}
