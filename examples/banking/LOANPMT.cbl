       IDENTIFICATION DIVISION.
       PROGRAM-ID. LOANPMT.
       AUTHOR. LENDING TEAM.
       DATE-WRITTEN. 09/1991.
      *----------------------------------------------------------------
      * LOAN MONTHLY PAYMENT FOR A FIXED-RATE AMORTIZING LOAN
      * USED BY THE BRANCH SCREEN SIMUL01 AND THE BATCH LOANNITE.
      * CHANGE 2009 : INSURANCE PREMIUM ADDED AFTER ROUNDING
      * MUE EXAMPLE - FICTIONAL SYSTEM
      *----------------------------------------------------------------
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       01  WS-CALC.
      *    MONTHLY RATE
           05  WS-R                PIC 9V9(9)     COMP-3.
      *    FACTOR (1 + R) TO THE POWER N
           05  WS-F                PIC 9(5)V9(9)  COMP-3.
       LINKAGE SECTION.
           COPY LOANREC.
       PROCEDURE DIVISION USING LOAN-REC.
       0000-MAIN.
           MOVE ZERO TO LOAN-PAYMENT
           EVALUATE TRUE
              WHEN LOAN-MONTHS = ZERO
                 MOVE 'E1' TO LOAN-RETURN-CODE
      *       SANITY CHECK : 40 YEARS AND 25 % MAXIMUM
              WHEN LOAN-MONTHS > 480 OR LOAN-ANNUAL-RATE > 25
                 MOVE 'E2' TO LOAN-RETURN-CODE
              WHEN LOAN-ANNUAL-RATE = ZERO
                 PERFORM 2000-ZERO-RATE
              WHEN OTHER
                 PERFORM 1000-AMORTIZING
           END-EVALUATE
           IF LOAN-INSURANCE = 'Y'
              ADD LOAN-INS-PREMIUM TO LOAN-PAYMENT
           END-IF
           GOBACK.
      *
       1000-AMORTIZING.
           COMPUTE WS-R = LOAN-ANNUAL-RATE / 1200
           COMPUTE WS-F = (1 + WS-R) ** LOAN-MONTHS
           COMPUTE LOAN-PAYMENT ROUNDED =
              LOAN-PRINCIPAL * WS-R * WS-F / (WS-F - 1)
           MOVE '00' TO LOAN-RETURN-CODE.
      *
       2000-ZERO-RATE.
           DIVIDE LOAN-PRINCIPAL BY LOAN-MONTHS
              GIVING LOAN-PAYMENT ROUNDED
           MOVE '00' TO LOAN-RETURN-CODE.
