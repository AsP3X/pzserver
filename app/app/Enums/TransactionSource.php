<?php

namespace App\Enums;

enum TransactionSource: string
{
    case AdminAward = 'admin_award';
    case Purchase = 'purchase';
    case Refund = 'refund';
    case System = 'system';
    case Payment = 'payment';
    case InGameDeposit = 'in_game_deposit';
    case AdminReset = 'admin_reset';
}
